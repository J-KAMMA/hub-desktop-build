// Static preparation only: downloaded modules are parsed, never imported or evaluated.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const ts = createRequire('C:/jkamma-platform/package.json')('typescript');
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const files = fs.readdirSync(dir).filter(f => /^ublock-src-js-resources-.*\.js$/.test(f) || /^ublock-src-js-(jsonpath|arglist-parser)\.js$/.test(f));
const declarations = new Map(), registrations = [], unsupported = [];
const value = n => {
  if (ts.isStringLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(n)) return { identifier: n.text };
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(value);
  throw new Error(`Unsupported metadata: ${n.getText()}`);
};
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(dir, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const node of source.statements) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declarations.set(node.name.text, { file, code: node.getText(source).replace(/^export\s+(?:default\s+)?/, '') });
    }
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue;
    const callName = node.expression.expression.getText(source);
    if (!['registerScriptlet', 'builtinScriptlets.push'].includes(callName)) continue;
    const [fn, metadata] = callName === 'registerScriptlet' ? node.expression.arguments : [null, node.expression.arguments[0]];
    if ((fn && !ts.isIdentifier(fn)) || !ts.isObjectLiteralExpression(metadata)) throw new Error(`Unsupported registration ${file}`);
    const details = Object.fromEntries(metadata.properties.map(p => {
      if (!ts.isPropertyAssignment(p)) throw new Error(`Unsupported property ${p.getText()}`);
      return [p.name.getText(source), value(p.initializer)];
    }));
    registrations.push({ ...details, fn: fn?.text || details.fn.identifier, file });
  }
}
const byFn = new Map(registrations.map(r => [r.fn, r]));
const byName = new Map(registrations.flatMap(r => [r.name, ...(r.aliases || [])].map(n => [n, r])));
const profile = { env_mv3: false, env_firefox: false, cap_html_filtering: false };
const selected = [], all = [];
const positiveYoutube = line => {
  const separator = line.search(/#(?:#|@#|\$#|%#|\?#)/);
  if (separator >= 0) return line.slice(0, separator).split(',').some(s => /^(?:[\w-]+\.)*youtube\.com$/.test(s));
  return /^\|\|(?:[\w-]+\.)*youtube\.com[\/^]/.test(line) || /\$[^\n]*\bdomain=(?:[^,]*\|)?(?:www\.)?youtube\.com(?:\||,|$)/.test(line);
};
for (const file of fs.readdirSync(dir).filter(f => /^uassets-filters-.*\.txt$/.test(f))) {
  const stack = [true];
  fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).forEach((line, index) => {
    const directive = line.match(/^!#(if|else|endif)(?:\s+(.*))?$/);
    if (directive) {
      if (directive[1] === 'if') {
        const expr = directive[2].trim(), neg = expr.startsWith('!'), key = neg ? expr.slice(1) : expr;
        const flag = Object.hasOwn(profile, key) ? (neg ? !profile[key] : profile[key]) : null;
        stack.push(stack.at(-1) === false ? false : flag === null ? null : stack.at(-1) === null ? null : flag);
      } else if (directive[1] === 'else') {
        const old = stack.pop(), parent = stack.at(-1);
        stack.push(parent === false ? false : old === null ? null : !old);
      } else stack.pop();
      return;
    }
    if (!line || line.startsWith('!') || !positiveYoutube(line)) return;
    const item = { file, line: index + 1, filter: line, active: stack.at(-1) };
    all.push(item);
    if (item.active === true) selected.push(item);
    if (item.active === null) unsupported.push({ ...item, reason: 'unknown environment conditional; excluded' });
  });
}
const scriptlets = selected.filter(r => r.filter.includes('##+js('));
const rootNames = [...new Set(scriptlets.map(r => r.filter.match(/##\+js\(\s*([^,)]+)/)[1].trim() + '.js'))];
const resources = new Map(), metadata = [];
const add = name => {
  const r = byName.get(name);
  if (!r) throw new Error(`Missing resource ${name}`);
  if (resources.has(r.name)) return;
  const d = declarations.get(r.fn);
  if (!d) throw new Error(`Missing declaration ${r.fn}`);
  const dependencies = (r.dependencies || []).map(dep => typeof dep === 'string' ? dep : byFn.get(dep.identifier)?.name);
  if (dependencies.some(d => !d)) throw new Error(`Unresolved dependency ${r.name}`);
  const resource = { name: r.name, aliases: r.aliases || [], kind: { mime: 'application/javascript' }, content: Buffer.from(d.code).toString('base64'), dependencies, permission: r.requiresTrust ? 1 : 0 };
  resources.set(r.name, resource);
  metadata.push({ name: r.name, declaration: r.fn, file: d.file, world: r.world || 'MAIN', requiresTrust: !!r.requiresTrust });
  dependencies.forEach(add);
};
rootNames.forEach(add);
for (const item of selected) {
  const reason = /\$[^\n]*\breplace=/.test(item.filter) ? 'network response replacement requires response-body hook; not network blocking' : item.filter.includes('##^') ? 'HTML response filtering requires response-body hook' : /:(?:remove|remove-attr|style)\(/.test(item.filter) ? 'procedural/action cosmetic filter requires compatible cosmetic executor' : null;
  if (reason) unsupported.push({ ...item, reason });
}
const write = (name, data) => fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
write('youtube-resources.json', [...resources.values()]);
write('youtube-scriptlets.chromium.txt', '! Static Chromium profile; trusted upstream rules require PermissionMask bit 0.\n' + scriptlets.map(r => r.filter).join('\n') + '\n');
for (const world of ['MAIN', 'ISOLATED']) {
  write(`youtube-scriptlets.${world.toLowerCase()}.chromium.txt`, scriptlets.filter(r => (byName.get(r.filter.match(/##\+js\(\s*([^,)]+)/)[1].trim() + '.js').world || 'MAIN') === world).map(r => r.filter).join('\n') + '\n');
}
write('youtube-cosmetic.chromium.txt', selected.filter(r => /#(?:#|@#)/.test(r.filter) && !r.filter.includes('+js(') && !r.filter.includes('##^')).map(r => r.filter).join('\n') + '\n');
write('youtube-rules.chromium.txt', selected.map(r => r.filter).join('\n') + '\n');
write('youtube-rules.provenance.json', { profile, scope: 'positive YouTube domains only in five pinned uAssets files; not complete uAssets', rules: all });
write('youtube-compatibility.json', { status: 'static resource/dependency preparation; no downloaded JavaScript executed; no YouTube playback verification', resources: resources.size, roots: rootNames, scriptletRules: scriptlets.length, selectedRules: selected.length, resourceMetadata: metadata, unsupported, wrapperRequirements: ['honor MAIN versus ISOLATED root worlds; JSON format itself carries no world; provided separate rule files', 'MAIN world at document creation, on YouTube domains only; iframe policy still requires root review', 'const scriptletGlobals = new Map() before generated script, avoid enabling debug logging', 'trusted upstream rules require ParseOptions.permissions bit 0; do not enable globally for user lists', 'apply scriptlet/cosmetic exceptions; do not inject every rule indiscriminately'] });
write('ATTRIBUTION.txt', 'uBlock Origin resource source: https://github.com/gorhill/uBlock/tree/562f5731509386f9eb40fc79a1a6d14ded207a61/src/js/resources\nCopyright 2014-present Raymond Hill and contributors; GPL-3.0-or-later; see ublock-LICENSE.txt and retained original source files.\nDerived Resource JSON preserves function declarations; converted statically by prepare-youtube-resources.mjs.\nuAssets filters: https://github.com/uBlockOrigin/uAssets/tree/5d93a8f7fcc36057407d6700bb0075c68f890624/filters\nGPL-3.0; see uassets-LICENSE and retained original filters.\nBrave adblock-resources: https://github.com/brave/adblock-resources/tree/6da9b247c3368baa8b4f24cd02046e18702a6527\nMPL-2.0; see brave-LICENSE. Brave custom resources retained for comparison only, not merged into YouTube resources.\n');
const hashes = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile() && f !== 'youtube-manifest.json').map(file => { const bytes = fs.readFileSync(path.join(dir, file)); return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; });
write('youtube-manifest.json', { generatedAt: new Date().toISOString(), sources: ['brave-source-manifest.json', 'uassets-source.json', 'ublock-source.json'], hashes });
console.log(JSON.stringify({ resources: resources.size, roots: rootNames, scriptletRules: scriptlets.length, selectedRules: selected.length, unsupported: unsupported.length, worlds: [...new Set(metadata.map(r => r.world))] }));
