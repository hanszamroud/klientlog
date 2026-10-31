// Klientlog, lokal udgave: alle data gemmes i telefonens eget lager (IndexedDB).
// Stiller den samme lille database-flade til rådighed som Claude-udgaven bruger.
(function(){
  window.__klientlogLocal = true;
  const DB_NAME = 'klientlog', STORE = 'docs';
  let dbp = null, loaded = null;
  const cache = new Map();          // path -> document body
  const listeners = new Map();      // collection path -> Set(fn)

  function open(){
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function loadAll(){
    if (loaded) return loaded;
    loaded = open().then(d => new Promise((res, rej) => {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => { const c = req.result; if (c){ cache.set(c.key, c.value); c.continue(); } else res(); };
      req.onerror = () => rej(req.error);
    }));
    return loaded;
  }
  function tx(mode, fn){
    return open().then(d => new Promise((res, rej) => {
      const t = d.transaction(STORE, mode); fn(t.objectStore(STORE));
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
  }
  const parent = p => p.split('/').slice(0, -1).join('/');
  const idOf = p => p.split('/').pop();
  function notify(coll){ const set = listeners.get(coll); if (set) for (const fn of [...set]) fn(); }
  async function put(path, data){ await loadAll(); const body = JSON.parse(JSON.stringify(data)); cache.set(path, body); await tx('readwrite', st => st.put(body, path)); notify(parent(path)); }
  async function remove(path){ await loadAll(); cache.delete(path); await tx('readwrite', st => st.delete(path)); notify(parent(path)); }
  function docsIn(coll){
    const prefix = coll + '/', out = [];
    for (const [p, v] of cache){ if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push({ id: p.slice(prefix.length), data: v }); }
    return out;
  }
  const meta = () => ({ fromCache: false, hasPendingWrites: false });
  const snapOf = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: meta() });
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function query(coll, order, lim){
    const build = () => {
      let docs = docsIn(coll);
      if (order){
        const { f, dir } = order;
        docs.sort((a, b) => { const x = a.data[f], y = b.data[f]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); });
      } else docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (lim) docs = docs.slice(0, lim);
      const snaps = docs.map(d => snapOf(d.id, d.data));
      return { docs: snaps, size: snaps.length, empty: !snaps.length, docChanges: () => snaps.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })), metadata: meta() };
    };
    return {
      path: coll,
      where: () => query(coll, order, lim),
      orderBy: (f, dir) => query(coll, { f, dir: dir || 'asc' }, lim),
      limit: n => query(coll, order, n),
      get: async () => { await loadAll(); return build(); },
      onSnapshot: (cb, err) => {
        let active = true; const fn = () => { if (active) cb(build()); };
        let set = listeners.get(coll); if (!set){ set = new Set(); listeners.set(coll, set); } set.add(fn);
        loadAll().then(fn, e => { if (err) err({ code: 'unavailable', message: String(e) }); });
        return () => { active = false; set.delete(fn); };
      },
      doc: id => docRef(coll + '/' + (id || genId())),
      add: async data => { const ref = docRef(coll + '/' + genId()); await ref.set(data); return ref; }
    };
  }
  function docRef(path){
    return {
      id: idOf(path), path,
      get: async () => { await loadAll(); return snapOf(idOf(path), cache.get(path)); },
      set: data => put(path, data),
      update: async data => { await loadAll(); const cur = cache.get(path); if (!cur) throw { code: 'invalid_argument', message: 'Dokumentet findes ikke' }; return put(path, Object.assign({}, cur, data)); },
      delete: () => remove(path),
      acquire: async () => ({ acquired: true }),
      onSnapshot: (cb, err) => {
        let active = true; const coll = parent(path); const fn = () => { if (active) cb(snapOf(idOf(path), cache.get(path))); };
        let set = listeners.get(coll); if (!set){ set = new Set(); listeners.set(coll, set); } set.add(fn);
        loadAll().then(fn, e => { if (err) err({ code: 'unavailable', message: String(e) }); });
        return () => { active = false; set.delete(fn); };
      },
      collection: sub => query(path + '/' + sub)
    };
  }
  const db = { doc: docRef, collection: p => query(p) };
  const user = { can: async () => true, isOwner: async () => true, canEdit: async () => true, id: async () => 'local', me: async () => ({ id: 'local', name: '' }) };
  const downloads = {
    async save({ filename, data }){
      const type = /\.json$/i.test(filename) ? 'application/json' : /\.csv$/i.test(filename) ? 'text/csv' : 'text/plain';
      const blob = data instanceof Blob ? data : new Blob([data], { type });
      try {
        const file = new File([blob], filename, { type });
        if (navigator.canShare && navigator.canShare({ files: [file] })){ await navigator.share({ files: [file], title: filename }); return { status: 'saved' }; }
      } catch (e){ if (e && e.name === 'AbortError') throw { code: 'declined', message: 'Annulleret' }; }
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
      return { status: 'saved' };
    }
  };
  window.claude = { use: async name => ({ db, user, downloads })[name] || null };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
