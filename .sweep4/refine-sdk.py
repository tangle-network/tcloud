from pathlib import Path
import subprocess
import json
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
for directory in ['tcloud', 'tcloud-agent']:
    p = Path('packages') / directory / 'package.json'
    manifest = json.loads(p.read_text())
    manifest['engines']['node'] = '>=20.19.0'
    p.write_text(json.dumps(manifest, indent=2) + '\n')
p = Path('packages/tcloud/CHANGELOG.md')
s = p.read_text()
s = s.replace('## 0.6.0\n', '## 0.6.0\n\nRequires Node 20.19 or later. GTR proof uses Node 22.\n', 1)
p.write_text(s)
