/**
 * @typedef {{ manager: 'npm'|'pnpm'|'yarn'|'bun'|'npx'|'pnpm dlx'|'bunx'|'yarn dlx', name: string, spec?: string, raw: string }} InstallRequest
 * @typedef {{ package: string, version?: string, verdict: 'ALLOW'|'REVIEW'|'BLOCK', summary?: string, findings?: {severity?: string, title: string}[], safeVersion?: {version: string, reason?: string} }} Report
 */

const valueFlags = new Set(['--registry', '--prefix', '--tag', '-w', '--workspace', '--filter', '--package', '-p', '--cache', '--userconfig', '--cwd', '--dir', '-C']);
const npmInstalls = new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isntall']);

// Shell-like tokenization, without evaluating expansions or executing anything.
// Separators inside quotes remain part of their argument.
function tokenize(command) {
  const segments = [];
  let tokens = [], token = '', started = false, quote = '';
  const flush = () => {
    if (started) tokens.push(token);
    token = '';
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'" && i + 1 < command.length) {
      const next = command[i + 1];
      if (next === '\n' || (next === '\r' && command[i + 2] === '\n')) {
        i += next === '\r' ? 2 : 1;
        continue;
      }
      if ((!quote && /[\s'"\\;&|]/.test(next)) || (quote === '"' && /["\\$`]/.test(next))) {
        token += next;
        started = true;
        i++;
        continue;
      }
    }
    if (quote) {
      if (c === quote) quote = '';
      else token += c;
      started = true;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      flush();
      segments.push(tokens);
      tokens = [];
    } else if (/[;&|\n\r]/.test(c)) {
      flush();
      segments.push(tokens);
      tokens = [];
    } else if (/\s/.test(c)) flush();
    else {
      token += c;
      started = true;
    }
  }
  flush();
  segments.push(tokens);
  return segments;
}

function parsePackage(raw, manager) {
  let value = raw;
  const alias = value.indexOf('@npm:');
  if (alias > 0) value = value.slice(alias + 5);
  else if (value.startsWith('npm:')) value = value.slice(4);
  if (/^(?:\.{0,2}[\\/]|~[\\/]|[a-z]:[\\/]|file:|link:|git\+|git:|github:|https?:)/i.test(value)) return null;
  if (/\.tgz(?:[?#].*)?$/i.test(value)) return null;
  const at = value.indexOf('@', value.startsWith('@') ? 1 : 0);
  const name = at < 0 ? value : value.slice(0, at);
  const spec = at < 0 ? undefined : value.slice(at + 1);
  if (!/^(?:@[a-z0-9_.~-]+\/)?[a-z0-9_.~-]+$/i.test(name)) return null;
  // A registry package name with a non-registry version is still a local/git install.
  if (spec && /^(?:\.{0,2}[\\/]|~[\\/]|[a-z]:[\\/]|file:|link:|git\+|git:|github:|https?:)/i.test(spec)) return null;
  if (spec && (/\.tgz(?:[?#].*)?$/i.test(spec) || /^[^@\s]+\/[^\s]+$/.test(spec))) return null;
  return { manager, name, ...(spec ? { spec } : {}), raw };
}

function skipFlag(tokens, i) {
  return valueFlags.has(tokens[i]) && !tokens[i].includes('=') ? i + 2 : i + 1;
}

/** Find explicit registry installs in a shell command. @param {string} command @returns {InstallRequest[]} */
export function findInstalls(command) {
  const installs = [];
  for (const tokens of tokenize(command)) {
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (tokens[i] === 'sudo') {
      i++;
      while (tokens[i]?.startsWith('-')) {
        i += ['-u', '-g', '-h', '-p', '--user', '--group', '--host', '--prompt'].includes(tokens[i]) ? 2 : 1;
      }
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    }
    const executable = tokens[i++]?.toLowerCase();
    if (!['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx'].includes(executable)) continue;
    let manager = executable;
    let runner = executable === 'npx' || executable === 'bunx';
    if (!runner) {
      while (tokens[i]?.startsWith('-')) i = skipFlag(tokens, i);
      const verb = tokens[i++]?.toLowerCase();
      if (executable === 'npm' && ['exec', 'x'].includes(verb)) {
        manager = 'npx';
        runner = true;
      } else if (['pnpm', 'yarn'].includes(executable) && verb === 'dlx') {
        manager = `${executable} dlx`;
        runner = true;
      } else if (!(executable === 'npm' ? npmInstalls.has(verb)
        : executable === 'yarn' ? verb === 'add' : ['add', 'install', 'i'].includes(verb))) continue;
    }
    const packages = [], explicit = [];
    for (; i < tokens.length;) {
      const token = tokens[i];
      if (token === '--') {
        packages.push(...tokens.slice(i + 1));
        break;
      }
      if (token.startsWith('-')) {
        if (runner && /^(?:--package|-p)(?:=|$)/.test(token)) {
          const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[i + 1];
          if (value) explicit.push(value);
        }
        i = skipFlag(tokens, i);
      } else {
        packages.push(token);
        // Runner arguments belong to the invoked program, not the package manager.
        if (runner) break;
        i++;
      }
    }
    const candidates = runner ? (explicit.length ? explicit : packages.slice(0, 1)) : packages;
    for (const raw of candidates) {
      const parsed = parsePackage(raw, manager);
      if (parsed) installs.push(parsed);
    }
  }
  return installs;
}

/** Combine package reports into one hook decision. @param {Report[]} reports */
export function decide(reports) {
  const decision = reports.some(report => report.verdict === 'BLOCK') ? 'deny'
    : reports.some(report => report.verdict === 'REVIEW') ? 'ask' : 'allow';
  const reason = reports.map(report => {
    const label = `${report.package}${report.version && report.version !== '-' ? `@${report.version}` : ''}`;
    const findings = (report.findings ?? []).slice(0, report.verdict === 'BLOCK' ? 2 : 1).map(finding => finding.title).join('; ');
    const detail = findings || report.summary || 'No findings reported';
    const advice = report.verdict === 'BLOCK' && report.safeVersion?.version
      ? ` Install ${report.package}@${report.safeVersion.version} instead.`
      : report.verdict === 'REVIEW' ? ' Ask the user before installing.' : '';
    return `Dep Bouncer ${report.verdict} ${label}: ${detail.replace(/[\r\n]+/g, ' ').replace(/\.+$/, '')}.${advice}`;
  }).join('\n');
  return { decision, reason };
}
