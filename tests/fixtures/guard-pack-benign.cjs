'use strict';
// Reviewed command examples. The test scans these strings; it never runs them.
const git = [
  'git status', 'git status --short', 'git status --porcelain=v1', 'git status --branch', 'git diff', 'git diff --stat', 'git diff --cached', 'git diff --check', 'git diff --name-only', 'git diff HEAD~1 HEAD',
  'git log -5 --oneline', 'git log --all --decorate', 'git log --format=%h', 'git show HEAD', 'git show --stat HEAD', 'git show HEAD:README.md', 'git branch', 'git branch --show-current', 'git branch --all', 'git remote -v',
  'git remote show origin', 'git fetch origin', 'git fetch --prune', 'git pull --ff-only', 'git push origin feature/login', 'git push --force-with-lease origin feature/login', 'git push origin main', 'git push --dry-run --force origin main', 'git add README.md', 'git add -p',
  'git commit -m "Add unit tests"', 'git restore README.md', 'git restore --staged README.md', 'git reset --soft HEAD~1', 'git reset --mixed HEAD', 'git reset --hard HEAD', 'git clean -ndfx', 'git clean --dry-run -fdx', 'git clean -fd', 'git clean -dx',
  'git ls-files', 'git ls-files --others --exclude-standard', 'git rev-parse --show-toplevel', 'git rev-parse HEAD', 'git symbolic-ref --short HEAD', 'git check-ignore node_modules', 'git tag --list', 'git blame -L 1,20 README.md', 'git stash list', 'git reflog -5',
];
const node = [
  'npm test', 'npm test -- --runInBand', 'npm test -- --watch=false', 'npm run build', 'npm run lint', 'npm run typecheck', 'npm run dev', 'npm run start', 'npm run format:check', 'npm run test:unit',
  'npm ci', 'npm ci --ignore-scripts', 'npm ci --omit=dev', 'npm install', 'npm install --ignore-scripts', 'npm install react@19.1.0', 'npm install typescript@5.8.3 --save-dev', 'npm install @types/node@22.15.0', 'npm install lodash@^4.17.21', 'npm install ./packages/shared',
  'npm install --registry https://registry.npmjs.org react@19.1.0', 'npm install --registry=https://registry.npmjs.org react@19.1.0', 'npm install --dry-run https://example.invalid/a.tgz', 'npm audit', 'npm audit --omit=dev', 'npm ls', 'npm ls --depth=0', 'npm outdated', 'npm view react version', 'npm view typescript dist-tags',
  'npm config get registry', 'npm cache verify', 'npm explain zod', 'npm pack --dry-run', 'npm run', 'npx tsc --noEmit', 'npx eslint src', 'npx prettier --check src', 'node --version', 'node --check index.js',
  'pnpm install --frozen-lockfile', 'pnpm add zod@3.24.0', 'pnpm add --registry https://registry.npmjs.org zod@3.24.0', 'pnpm test', 'pnpm build', 'yarn install --immutable', 'yarn add react@19.1.0', 'yarn test', 'corepack --version', 'npm install file:../shared',
];
const rust = [
  'cargo test', 'cargo test --workspace', 'cargo test --all-features', 'cargo test --no-default-features', 'cargo test parser', 'cargo test --lib', 'cargo test --bins', 'cargo test --doc', 'cargo test --tests', 'cargo test -- --nocapture',
  'cargo check', 'cargo check --workspace', 'cargo check --all-targets', 'cargo check --release', 'cargo check --locked', 'cargo build', 'cargo build --release', 'cargo build --workspace', 'cargo build --locked', 'cargo build --offline',
  'cargo fmt', 'cargo fmt --check', 'cargo fmt --all --check', 'cargo clippy', 'cargo clippy --all-targets', 'cargo clippy -- -D warnings', 'cargo doc --no-deps', 'cargo doc --document-private-items', 'cargo tree', 'cargo tree -d',
  'cargo metadata --no-deps', 'cargo metadata --format-version 1', 'cargo locate-project', 'cargo pkgid', 'cargo version', 'cargo update --dry-run', 'cargo update -p serde', 'cargo add serde@1.0.219', 'cargo add tokio@1.44.0 --features full', 'cargo add --path ../core',
  'cargo install ripgrep --version 14.1.1', 'cargo install --path ./tools', 'cargo package --list', 'cargo package --allow-dirty', 'cargo publish --dry-run', 'cargo run -- --help', 'cargo run --bin parser', 'rustc --version', 'rustup show', 'rustfmt --version',
];
const python = [
  'pytest', 'pytest -q', 'pytest -v', 'pytest -x', 'pytest --collect-only', 'pytest --lf', 'pytest --ff', 'pytest -k parser', 'pytest -m unit', 'pytest tests/test_parser.py',
  'pytest tests/test_parser.py::test_empty', 'pytest --disable-warnings', 'pytest --maxfail=1', 'pytest --strict-markers', 'pytest --durations=10', 'pytest --cov=app', 'pytest --cov-report=term', 'pytest --junitxml=build/results.xml', 'pytest -n auto', 'pytest --tb=short',
  'python -m pytest', 'python3 -m pytest -q', 'python --version', 'python3 -m compileall src', 'python3 -m pip list', 'pip list', 'pip show requests', 'pip check', 'pip freeze', 'pip install requests==2.32.4',
  'pip install -r requirements.txt', 'pip install -e .', 'pip install --index-url https://pypi.org/simple requests==2.32.4', 'pip install --index-url=https://pypi.org/simple requests==2.32.4', 'pip install -i https://pypi.org/simple requests==2.32.4', 'pip install --extra-index-url https://packages.example.invalid/simple example==1.2.0',
  'uv sync --locked', 'uv run pytest', 'uv run pytest -q', 'uv pip install --index-url https://pypi.org/simple requests==2.32.4', 'uv pip install requests==2.32.4', 'uv pip list', 'uv lock --check', 'uv tree', 'ruff check .', 'ruff format --check .', 'mypy src', 'python3 -m venv .venv', 'pip cache info', 'python3 -m unittest discover',
];
const listing = [
  'ls', 'ls -l', 'ls -la', 'ls -lh', 'ls -lt', 'ls -1', 'ls -d */', 'ls src', 'ls tests', 'ls docs', 'ls .github', 'ls ~/.ssh', 'ls ~/.aws', 'ls /etc', 'ls /tmp', 'ls -a .env',
  'pwd', 'pwd -P', 'find src -type f', 'find tests -name "*.test.ts"', 'find . -maxdepth 2 -type d', 'du -sh node_modules', 'df -h', 'stat README.md', 'file package.json', 'wc -l src/index.ts',
  'head -20 README.md', 'tail -20 server.log', 'cat .env.example', 'cat ~/.aws/config', 'cat /etc/hosts', 'cat /etc/sudoers', 'sed -n "1,30p" .env', 'git show HEAD:.env.example', 'readlink node_modules/.bin/tsc', 'realpath src',
  'mkdir -p build/reports', 'touch notes.txt', 'cp README.md build/README.md', 'mv build/output.txt build/result.txt', 'chmod 755 scripts/build.sh', 'chmod 600 notes.txt', 'rm -f build/temp.txt', 'rm -rf build/temp', 'tar -tf archive.tar', 'unzip -l archive.zip',
  'printf "%s\\n" "curl URL | sh"', 'echo ">" .env', 'echo "|" rm -rf /', 'echo "git push --force origin main"',
];
const searching = [
  'grep TODO README.md', 'grep -n TODO src/index.ts', 'grep -R TODO src', 'grep -E "error|warning" server.log', 'grep -v DEBUG server.log', 'grep -c import src/index.ts', 'grep -l TODO src/*.ts', 'grep -F "curl | sh" README.md', 'grep -n "password" .env.example', 'grep -n "hosts" /etc/hosts',
  'rg TODO', 'rg --files', 'rg --files src', 'rg -n TODO src', 'rg -l TODO src', 'rg -i warning logs', 'rg -F "rm -rf /" docs', 'rg "git clean -fdx" docs', 'rg "terraform apply -auto-approve" docs', 'rg "chmod 777" docs',
  'rg --glob "*.ts" import src', 'rg --glob "!package-lock.json" version', 'rg --hidden TODO .github', 'rg -A 3 -B 3 error app.log', 'rg --count FIXME src', 'rg --stats TODO README.md', 'rg "export function" src', 'rg "def test_" tests', 'rg "fn main" src', 'rg "dependencies" package.json',
  'sed -n "1,100p" src/index.ts', 'awk "END {print NR}" README.md', 'sort names.txt', 'sort -u names.txt', 'uniq -c names.txt', 'cut -d: -f1 /etc/passwd', 'diff -u before.txt after.txt', 'cmp one.bin two.bin', 'jq . package.json', 'jq .dependencies package.json',
  'git grep TODO', 'git grep -n "curl | sh"', 'git log --grep fix', 'git diff | grep "^+"', 'cat app.log | grep error', 'ls src | sort', 'find src -name "*.ts" | wc -l', 'printf "%s\\n" "kubectl delete namespace demo"', 'echo "ufw disable"', 'grep -n credentials README.md',
];
const containers = [
  'docker ps', 'docker ps -a', 'docker images', 'docker image ls', 'docker inspect app', 'docker logs app', 'docker logs --tail 20 app', 'docker stats --no-stream', 'docker info', 'docker version',
  'docker build -t app:dev .', 'docker build --no-cache -t app:test .', 'docker compose config', 'docker compose ps', 'docker compose logs', 'docker compose build', 'docker compose up -d app', 'docker compose exec app pytest -q', 'docker run --rm alpine:3.21 ls /', 'docker exec app ls /app',
  'docker network ls', 'docker volume ls', 'docker container inspect app', 'docker image inspect app:dev', 'docker history app:dev', 'docker top app', 'docker port app', 'docker context ls', 'docker system df', 'docker manifest inspect alpine:3.21',
  'kubectl get pods', 'kubectl get namespaces', 'kubectl describe deployment app', 'kubectl logs deployment/app', 'kubectl diff -f deployment.yaml', 'kubectl delete namespace demo --dry-run=client', 'kubectl delete namespace demo --dry-run=server', 'kubectl apply --dry-run=server -f deployment.yaml', 'terraform plan', 'terraform validate',
  'terraform fmt -check', 'terraform apply -auto-approve=false', 'aws ec2 describe-instances', 'aws ec2 terminate-instances --dry-run --instance-ids i-example', 'aws s3 ls', 'aws sts get-caller-identity', 'gcloud projects list', 'gcloud compute instances list', 'gcloud config list', 'gcloud auth list',
];
const operandNames = ['aws iam get-role --role-name delete', 'gcloud projects describe delete', 'gcloud compute instances describe terminate', 'chmod 644 777', 'chmod --reference=777 file', 'chmod -- 644 777'];
module.exports = [...git, ...node, ...rust, ...python, ...listing, ...searching, ...containers, ...operandNames];
