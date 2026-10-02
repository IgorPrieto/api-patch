// Runs one exported function of a demo consumer module and prints the outcome as JSON.
// The consumer uses same-origin relative URLs, so this harness plays the role of the page
// origin: relative URLs resolve against the ephemeral loopback base and any other origin is
// refused. It is started by APIPatch with the Node permission model (read-only access to the
// consumer and this file, no child processes, no writes) and an empty environment.
// argv: <consumer module file> <loopback base URL> <export name> <JSON array of arguments>
import { pathToFileURL } from 'node:url';

const [moduleFile, base, name, rawArgs] = process.argv.slice(2);
const print = value => process.stdout.write(JSON.stringify(value));

try {
  if (!moduleFile || !base || !name || rawArgs === undefined) throw new Error('usage: consumer-harness <module> <base> <export> <args-json>');
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('base must be an http://127.0.0.1 loopback URL');
  const args = JSON.parse(rawArgs);
  if (!Array.isArray(args)) throw new Error('arguments must be a JSON array');
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, origin);
    if (url.origin !== origin.origin) throw new Error(`harness refused non-demo origin ${url.origin}`);
    return nativeFetch(url, init);
  };
  const consumer = await import(pathToFileURL(moduleFile).href);
  if (typeof consumer[name] !== 'function') throw new Error(`consumer does not export function ${name}`);
  try {
    const value = await consumer[name](...args);
    print(value === undefined ? { outcome: 'returned', undefined: true } : { outcome: 'returned', value });
  } catch (error) {
    print({ outcome: 'threw', message: error instanceof Error ? error.message : String(error) });
  }
} catch (error) {
  print({ outcome: 'harness-error', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
