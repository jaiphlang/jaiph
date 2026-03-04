const { execSync } = require('child_process');
const fs = require('fs');
try {
  execSync('node ./node_modules/typescript/bin/tsc -p tsconfig.json', {
    cwd: __dirname,
    stdio: 'pipe',
    encoding: 'utf8'
  });
  fs.writeFileSync(__dirname + '/.build-result.txt', 'OK');
} catch (e) {
  fs.writeFileSync(__dirname + '/.build-result.txt', 'FAIL\n' + (e.stderr || e.stdout || e.message));
  process.exit(1);
}
