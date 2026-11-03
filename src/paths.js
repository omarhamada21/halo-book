import path from 'path';
import { fileURLToPath } from 'url';

// Project root directory. Replaces the `__dirname` that server.js derived from its own location,
// so moved code that builds paths like path.join(__dirname, 'public', ...) resolves exactly as before.
const __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export { __dirname };
