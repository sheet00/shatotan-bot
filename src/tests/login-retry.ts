import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const interval = 60 * 60 * 1000;
while (true) {
  const next = new Date(Date.now() + interval);
  console.log(`次のログイン確認: ${next.toISOString()}`);
  await setTimeout(interval);
  let output = '';
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'login.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (chunk: Buffer) => {
    output += chunk.toString();
    process.stdout.write(chunk);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code === 0) break;
  if (!/ログイン制限|not allowed to log in at this time/i.test(output)) {
    process.exitCode = 1;
    break;
  }
}
