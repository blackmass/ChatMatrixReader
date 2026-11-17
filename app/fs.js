// Files of the program folder (the folder with app/, config.json, Glossary.txt ...). Paths are relative to it and cannot leave it:
// the exe refuses "..", drive letters and links that lead out (src-tauri/src/files.rs).
//   import { files } from './fs.js'
//   const text = await files.read('config.json')          // string, or null when it does not exist
//   await files.write('config.json', text)                // all or nothing: a crash never leaves half a file
//   await files.append('logs/chatmatrix.log', line)
//   await files.kind('extensions/stt')                    // 'file' | 'dir' | ''
//   await files.list('extensions')                        // ['stt/', 'readme.txt']  (a folder ends with "/")
//   await files.mkdir('extensions/stt')   await files.remove('logs/old.log')      // remove: files only
// The same six calls exist in tests/memoryfiles.mjs (an in-memory stand-in), so the core can be tested without the exe.
const invoke = window.__TAURI__.core.invoke;

export const files = {
  read: path => invoke('fs_read', { path }),
  write: (path, text) => invoke('fs_write', { path, text }),
  append: (path, text) => invoke('fs_append', { path, text }),
  kind: path => invoke('fs_kind', { path }),
  list: path => invoke('fs_list', { path }),
  mkdir: path => invoke('fs_mkdir', { path }),
  remove: path => invoke('fs_remove', { path }),
};
