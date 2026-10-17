import { Injectable } from '@nitrostack/core';
import type { AnalysisContext, Finding, PackageInfo, Signal } from '../signal.js';
import { findLookalikes } from '../name-similarity.js';
import { loadPopularPackages } from '../popular-packages.js';
import { finding, formatAge, hoursBetween, installScripts, REPLAY_NOW } from './finding.js';

const MAX_LOOKUPS = 30;
const LOOKUP_CONCURRENCY = 5;

interface DepVerdict {
  name: string;
  range: string;
  reasons: string[];
  score: number;
}

/**
 * Dependencies the release adds. The axios 2026 hijack changed no code at all: it only added
 * `plain-crypto-js`, a day-old look-alike of `crypto-js` whose postinstall dropped a RAT, and
 * axios never even imported it.
 */
@Injectable()
export class NewDepsSignal implements Signal {
  readonly id = 'new-deps';

  async evaluate(ctx: AnalysisContext & { signal?: AbortSignal; deadline?: number }): Promise<Finding[]> {
    const previous = ctx.baseline[0];
    if (!previous) return [];
    const before = { ...previous.dependencies, ...previous.optionalDependencies };
    const now = { ...ctx.target.dependencies, ...ctx.target.optionalDependencies };
    const ownScope = scopeOf(ctx.name);
    const optional = new Set(Object.keys(ctx.target.optionalDependencies ?? {}));
    const all = Object.keys(now).filter((d) => !Object.hasOwn(before, d));
    const own = all.filter((d) => ownScope && d.startsWith(ownScope));
    const added = all.filter((d) => !ownScope || !d.startsWith(ownScope));
    const stopped = () => ctx.signal?.aborted || (ctx.deadline !== undefined && Date.now() >= ctx.deadline);
    if (!all.length) return [];

    const referenced = stopped() ? null : await this.referencedNames(ctx, added.slice(0, MAX_LOOKUPS));
    const popular = await loadPopularPackages();
    const checkedAt = ctx.reconstructed
      ? REPLAY_NOW(ctx.time[ctx.target.version])
      : new Date().toISOString();

    const verdicts: DepVerdict[] = [];
    let examined = 0;
    const pending = added.slice(0, MAX_LOOKUPS);
    let next = 0;
    const inspect = async (name: string) => {
      let info: PackageInfo | null | undefined;
      try {
        info = ctx.lookupPackage ? await ctx.lookupPackage(name, now[name]) : undefined;
      } catch {
        info = undefined;
      }
      examined++;
      const manifest = info?.resolved ?? info?.latest;
      const owner = ctx.target._npmUser?.name;
      if (!info?.knownMalicious && owner && manifest?._npmUser?.name === owner) {
        own.push(name);
        return;
      }
      // Optional platform packages are resolved by computed name, so "never imported" is normal.
      verdicts.push(this.judge(name, now[name], info, optional.has(name) ? null : referenced, popular, checkedAt));
    };
    await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, pending.length) }, async () => {
      while (!stopped() && next < pending.length) {
        await inspect(pending[next++]);
      }
    }));

    const out: Finding[] = [];
    const unexamined = added.length - examined;
    if (unexamined) out.push(finding(this.id, 'warn', `${unexamined} new dependencies not examined`,
      [stopped() ? 'Dependency check deadline exceeded or cancelled' : `Lookup limit: ${MAX_LOOKUPS}`]));
    if (own.length) out.push(finding(this.id, 'info', `${own.length} new dependencies from the project's own scope or publisher`,
      [own.slice(0, 8).join(', ')]));
    for (const v of verdicts.sort((a, b) => b.score - a.score)) {
      if (v.score >= 3) {
        out.push(
          finding(this.id, 'critical', `New dependency ${v.name} looks like a malware drop`, [
            `${v.name}@${v.range} added since ${previous.version}`,
            ...v.reasons,
          ]),
        );
      } else if (v.score === 2) {
        out.push(
          finding(this.id, 'high', `Suspicious new dependency ${v.name}`, [
            `${v.name}@${v.range} added since ${previous.version}`,
            ...v.reasons,
          ]),
        );
      }
    }
    const minor = verdicts.filter((v) => v.score === 1);
    if (minor.length) {
      out.push(
        finding(
          this.id,
          'warn',
          minor.length === 1 ? `New dependency ${minor[0].name}` : `${minor.length} new dependencies with minor flags`,
          minor.slice(0, 5).map((v) => `${v.name}: ${v.reasons.join('; ')}`),
        ),
      );
    }
    const benign = verdicts.filter((v) => v.score === 0).map((v) => v.name);
    if (benign.length) {
      out.push(
        finding(this.id, 'info', `${benign.length} new established dependencies`, [benign.join(', ')]),
      );
    }
    return out;
  }

  private judge(
    name: string,
    range: string,
    info: PackageInfo | null | undefined,
    referenced: Set<string> | null,
    popular: string[],
    checkedAt: string,
  ): DepVerdict {
    const reasons: string[] = [];
    let score = 0;
    if (info === null) {
      return { name, range, reasons: [`${name} does not exist on npm`], score: 3 };
    }
    if (info) {
      if (info.knownMalicious) return { name, range, reasons: [`${name}@${info.resolved?.version ?? info.latest?.version ?? range} listed as malware in OSV`], score: 3 };
      if (info.created) {
        const age = hoursBetween(info.created, checkedAt);
        if (age < 7 * 24) {
          score++;
          reasons.push(`${name} was created ${formatAge(Math.max(age, 0))} ago`);
        }
      }
      if (info.versionCount <= 3) {
        reasons.push(`${name} has only ${info.versionCount} version(s)`);
      }
      const manifest = info.resolved ?? info.latest;
      const scripts = manifest ? installScripts(manifest) : {};
      const hooks = Object.entries(scripts);
      if (hooks.length) {
        score++;
        reasons.push(`${name} runs code at install: ${hooks.map(([k, s]) => `${k}: ${s}`).join('; ')}`);
      }
      if (info.weeklyDownloads !== undefined && info.weeklyDownloads < 1000) {
        reasons.push(`${name} has ${info.weeklyDownloads} weekly downloads`);
      }
    }
    const [lookalike] = findLookalikes(name, popular);
    if (lookalike) {
      score++;
      reasons.push(`name looks like the popular package ${lookalike.name} (${lookalike.kind})`);
    }
    if (referenced && !referenced.has(name)) {
      score++;
      reasons.push(`no file in the package imports ${name} (phantom dependency)`);
    }
    return { name, range, reasons, score: Math.min(score, 3) };
  }

  /** Names imported anywhere in the target's JS files; null if files can't be loaded. */
  private async referencedNames(ctx: AnalysisContext & { signal?: AbortSignal; deadline?: number }, names: string[]): Promise<Set<string> | null> {
    if (!names.length) return new Set();
    try {
      const files = await ctx.loadFiles(ctx.target.version);
      const found = new Set<string>();
      const decoder = new TextDecoder();
      for (const [path, bytes] of files) {
        if (ctx.signal?.aborted || (ctx.deadline !== undefined && Date.now() >= ctx.deadline)) return null;
        if (!/\.(c|m)?(j|t)sx?$/.test(path) || bytes.byteLength > 4 * 1024 * 1024) continue;
        const text = decoder.decode(bytes);
        for (const n of names) {
          if (found.has(n)) continue;
          if (text.includes(`'${n}`) || text.includes(`"${n}`) || text.includes(`\`${n}`)) found.add(n);
        }
        if (found.size === names.length) break;
      }
      return found;
    } catch {
      return null;
    }
  }
}

function scopeOf(name: string): string | undefined {
  return name.startsWith('@') ? `${name.split('/')[0]}/` : undefined;
}
