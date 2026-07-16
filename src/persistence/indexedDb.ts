import { deserializeSave, serializeSave, type SaveStore } from './saveStore.ts';
import type { GameState } from '../sim/state.ts';

/**
 * IndexedDB-backed SaveStore (U11, KTD8). Async so autosave writes never stall
 * the game loop. Chosen over localStorage for capacity and non-blocking writes.
 * Not unit-tested here (needs a browser IndexedDB); the serialization contract
 * it relies on is proven in the saveStore round-trip tests.
 */
const DB_NAME = 'railroad-econ-sim';
const STORE = 'saves';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = run(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export class IndexedDbSaveStore implements SaveStore {
  async save(slot: string, state: GameState): Promise<void> {
    await tx('readwrite', (store) => store.put(serializeSave(state), slot));
  }

  async load(slot: string): Promise<GameState | null> {
    const json = await tx<string | undefined>('readonly', (store) => store.get(slot));
    return json ? deserializeSave(json) : null;
  }

  async list(): Promise<string[]> {
    const keys = await tx<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return keys.map(String).sort();
  }

  async remove(slot: string): Promise<void> {
    await tx('readwrite', (store) => store.delete(slot));
  }
}
