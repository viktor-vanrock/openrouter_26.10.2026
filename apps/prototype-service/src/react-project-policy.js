import path from 'node:path';
import { createRequire } from 'node:module';
import { validateSourcePath, sourceBytes, SOURCE_LIMITS } from './source-manifest.js';
let ts;
try {
  ts = createRequire(import.meta.url)('typescript');
} catch {
  ts = createRequire('/opt/prototype/template/package.json')('typescript');
}
const layers = ['app', 'pages', 'widgets', 'features', 'entities', 'shared'];
const packages = new Set(['react', '@ai-sber/uikit', 'lucide-react', 'dayjs', 'react-router-dom']);
const immutable = ['src/app/main.tsx', 'src/app/providers/index.tsx', 'src/app/styles/globals.css'];
const dangerousNames = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'eval',
  'Function',
  'globalThis',
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'require',
  'process',
  'Deno',
  'Bun',
  'importScripts',
  'self',
  'top',
  'parent',
  'frames',
  'open',
  'postMessage',
]);
function reject(code) {
  throw new Error(`PROTOTYPE_PROJECT_${code}`);
}
function layer(name) {
  return name.split('/')[1];
}
function slice(name) {
  return name.split('/').slice(0, 3).join('/');
}
function resolveImport(from, specifier, names) {
  if (packages.has(specifier)) return null;
  if (
    specifier.includes('\\') ||
    specifier.includes('\0') ||
    specifier.startsWith('/') ||
    specifier.includes('?') ||
    specifier.includes('#')
  )
    reject('IMPORT_INVALID');
  let base;
  if (specifier.startsWith('@/')) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith('./') || specifier.startsWith('../'))
    base = path.posix.join(path.posix.dirname(from), specifier);
  else reject('EXTERNAL_IMPORT_DENIED');
  const target = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.css`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ].find((name) => names.has(name));
  if (!target) reject('IMPORT_UNRESOLVED');
  const originLayer = layers.indexOf(layer(from)),
    targetLayer = layers.indexOf(layer(target));
  if (targetLayer < originLayer) reject('UPPER_LAYER_IMPORT');
  if (
    slice(from) !== slice(target) &&
    layer(target) !== 'app' &&
    ![`${slice(target)}/index.ts`, `${slice(target)}/index.tsx`].includes(target)
  )
    reject('SLICE_PRIVATE_IMPORT');
  return target;
}

/** AST/data-only validation. Network isolation and trusted build are separate mandatory gates. */
export function validateReactProject(sources, { fixedSources = {}, requireFsd = true } = {}) {
  if (!sources || Array.isArray(sources)) reject('INVALID');
  const entries = Object.entries(sources);
  const names = new Set([...Object.keys(sources), ...Object.keys(fixedSources)]);
  let total = 0;
  const meaningful = new Set(),
    kitFiles = new Set();
  const graph = new Map();
  if (entries.length < 1 || entries.length > SOURCE_LIMITS.maxFiles) reject('LIMIT');
  for (const [name, source] of entries) {
    validateSourcePath(name);
    const bytes = sourceBytes(source);
    total += bytes.length;
    if (bytes.length > SOURCE_LIMITS.maxFileBytes || total > SOURCE_LIMITS.maxSourceBytes)
      reject('LIMIT');
    if (
      immutable.some(
        (item) =>
          item === name ||
          name.startsWith('src/app/providers/') ||
          name.startsWith('src/app/styles/'),
      )
    )
      reject('IMMUTABLE_FILE');
    if (name.endsWith('.css')) {
      if (/@import|url\s*\(|expression\s*\(|-moz-binding/i.test(source)) reject('NETWORK_CODE');
      continue;
    }
    const file = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    if (file.parseDiagnostics.length) reject('SYNTAX');
    const imports = [],
      kitComponents = new Set(),
      kitNamespaces = new Set();
    for (const node of file.statements) {
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier.text === '@ai-sber/uikit' &&
        node.importClause &&
        !node.importClause.isTypeOnly
      ) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements) {
            if (!item.isTypeOnly) kitComponents.add(item.name.text);
          }
        else if (bindings && ts.isNamespaceImport(bindings)) kitNamespaces.add(bindings.name.text);
      }
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) reject('IMPORT_INVALID');
        const target = resolveImport(name, node.moduleSpecifier.text, names);
        if (target) imports.push(target);
      }
      if (
        ts.isImportEqualsDeclaration(node) ||
        (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      )
        reject('DYNAMIC_IMPORT');
      if (ts.isIdentifier(node) && dangerousNames.has(node.text)) reject('NETWORK_CODE');
      if (
        ts.isPropertyAccessExpression(node) &&
        ['constructor', '__proto__', 'prototype'].includes(node.name.text)
      )
        reject('DYNAMIC_CODE');
      if (
        ts.isElementAccessExpression(node) &&
        ((!ts.isStringLiteral(node.argumentExpression) &&
          !ts.isNumericLiteral(node.argumentExpression)) ||
          ['constructor', '__proto__', 'prototype'].includes(node.argumentExpression.text))
      )
        reject('DYNAMIC_CODE');
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        if (kitComponents.has(tag) || kitNamespaces.has(tag.split('.')[0])) kitFiles.add(name);
        if (['iframe', 'script', 'object', 'embed', 'link', 'img', 'video', 'audio'].includes(tag))
          reject('EXTERNAL_ASSET');
        for (const attr of node.attributes.properties) {
          if (
            ts.isJsxAttribute(attr) &&
            ['dangerouslySetInnerHTML', 'src', 'srcDoc', 'action', 'formAction'].includes(
              attr.name.getText(file),
            )
          )
            reject('EXTERNAL_ASSET');
        }
      }
      if (
        name === 'src/app/App.tsx' &&
        ts.isCallExpression(node) &&
        /^(?:useState|useReducer|createContext|React\.(?:useState|useReducer|createContext))$/.test(
          node.expression.getText(file),
        )
      ) {
        reject('APP_NOT_COMPOSITION');
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    graph.set(name, imports);
    if (
      file.statements.some(
        (node) =>
          ts.isFunctionDeclaration(node) ||
          ts.isVariableStatement(node) ||
          ts.isClassDeclaration(node),
      )
    )
      meaningful.add(layer(name));
    if (
      name === 'src/app/App.tsx' &&
      file.statements.some(
        (node) =>
          (ts.isFunctionDeclaration(node) && node.name?.text !== 'App') ||
          (ts.isVariableStatement(node) &&
            node.declarationList.declarations.some(
              (decl) =>
                decl.initializer &&
                !ts.isArrowFunction(decl.initializer) &&
                !ts.isFunctionExpression(decl.initializer),
            )),
      )
    )
      reject('APP_NOT_COMPOSITION');
  }
  if (!names.has('src/app/App.tsx') || !kitFiles.size) reject('REQUIRED_COMPONENTS');
  if (requireFsd) {
    const reachable = new Set();
    const walk = (name) => {
      if (reachable.has(name)) return;
      reachable.add(name);
      for (const target of graph.get(name) ?? []) walk(target);
    };
    walk('src/app/App.tsx');
    if (![...kitFiles].some((name) => reachable.has(name))) reject('REQUIRED_COMPONENTS');
    const connected = new Set([...reachable].map(layer));
    if (!layers.every((item) => connected.has(item) && meaningful.has(item)))
      reject('FSD_DECOMPOSITION');
    for (const name of names) {
      if (
        ['pages', 'widgets', 'features', 'entities'].includes(layer(name)) &&
        !names.has(`${slice(name)}/index.ts`) &&
        !names.has(`${slice(name)}/index.tsx`)
      )
        reject('SLICE_PUBLIC_API');
    }
  }
  return {
    files: entries.length,
    totalBytes: total,
    layers: [...meaningful],
    validatedAs: 'static-policy-only',
  };
}
