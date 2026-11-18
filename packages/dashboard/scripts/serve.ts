/**
 * Serves the dashboard against a deployed network: the API server and Vite, both in that network's mode.
 * Usage: npm run fuji -w @zkdb/dashboard
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'fuji';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, ZKDB_MODE: mode };
const children: ChildProcess[] = [];
const stop = (code = 0) => { for (const c of children) c.kill(); process.exit(code); };
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

const server = spawn('npx', ['tsx', 'server/main.ts'], { cwd, env, stdio: 'inherit' });
server.on('exit', () => { console.error('The API server stopped.'); stop(1); });
const ui = spawn('npx', ['vite', '--mode', mode, '--port', '5173', '--strictPort'], { cwd, env, stdio: 'inherit' });
ui.on('exit', (code) => stop(code ?? 0));
children.push(server, ui);
