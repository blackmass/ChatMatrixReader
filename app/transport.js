// The one door to the network: the program's requests (translation, model list ...) all go through this function, and the exe
// (Rust command `http_request`, src-tauri/src/main.rs) sends them. Nothing is sent from the web view itself.
//   transport({ url, method, headers: [[name, value], ...], body, timeout }) -> { status, body }      (rejects on network trouble)
const invoke = window.__TAURI__.core.invoke;
export const transport = ({ url, method, headers, body, timeout }) => invoke('http_request', { url, method, headers, body, timeout });
