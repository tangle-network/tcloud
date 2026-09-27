from pathlib import Path
import subprocess
p = Path('packages/tcloud/src/client.ts')
s = p.read_text()
a = '    const completion: ChatCompletion = await res.json()\n    this.trackCost(completion, res)'
b = '    const completion: ChatCompletion = await res.json()\n    // Only this SDK may mark a per-response receipt. Never trust an upstream extension.\n    delete completion.tangle\n    this.trackCost(completion, res)'
assert s.count(a) == 1
p.write_text(s.replace(a, b))
p = Path('.github/workflows/release.yml')
s = p.read_text()
a = 'run: pnpm --filter @tangle-network/tcloud build'
b = "run: pnpm --filter '@tangle-network/tcloud...' build"
assert s.count(a) == 1 or s.count(b) == 1
p.write_text(s.replace(a, b))
subprocess.run(['git', 'add', '.github/workflows/release.yml'], check=True)
