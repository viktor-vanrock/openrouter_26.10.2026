import { createRequire } from 'node:module';

// The local launcher uses repository TypeScript; the offline sandbox uses the
// compiler already installed in its immutable template image.
let compiler;
function typescript() {
  if (compiler) return compiler;
  try {
    compiler = createRequire(import.meta.url)('typescript');
  } catch {
    compiler = createRequire('/opt/prototype/template/package.json')('typescript');
  }
  return compiler;
}
const allowedImports = new Set([
  'react',
  '@ai-sber/uikit',
  'lucide-react',
  'dayjs',
  'react-router-dom',
]);
function invalidSource(reason, file, node, diagnosticCode) {
  const position =
    file && node
      ? file.getLineAndCharacterOfPosition(node.getStart ? node.getStart(file) : (node.start ?? 0))
      : null;
  return Object.assign(new Error('LIVE_MODEL_REACT_INVALID'), {
    code: 'LIVE_MODEL_REACT_INVALID',
    details: {
      reason,
      ...(position ? { lineNumber: position.line + 1, columnNumber: position.character + 1 } : {}),
      diagnosticCode,
    },
    diagnostics: [
      `React validation: ${reason}${position ? ` at App.tsx:${position.line + 1}:${position.character + 1}` : ''}${diagnosticCode ? ` (TS${diagnosticCode})` : ''}`,
    ],
  });
}

/** Parse as data, never evaluate source. Type/lint/build remain sandbox checks. */
export function validateReactSource(source) {
  if (typeof source !== 'string') throw invalidSource('source_not_text');
  if (!source.trim()) throw invalidSource('source_empty');
  if (Buffer.byteLength(source) > 200_000) throw invalidSource('source_too_large');
  const ts = typescript();
  const file = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (file.parseDiagnostics.length)
    throw invalidSource(
      'tsx_syntax_error',
      file,
      file.parseDiagnostics[0],
      file.parseDiagnostics[0].code,
    );
  const components = new Set();
  const namespaces = new Set();
  let appExport = false;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !allowedImports.has(statement.moduleSpecifier.text)
      )
        throw invalidSource('import_not_allowed', file, statement);
      const clause = statement.importClause;
      if (statement.moduleSpecifier.text === '@ai-sber/uikit' && clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements)
            if (!item.isTypeOnly) components.add(item.name.text);
        } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      }
    }
    if (
      ts.isImportEqualsDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier)
    )
      throw invalidSource('module_reference_not_allowed', file, statement);
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'App') appExport = true;
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((item) => item.name.getText(file) === 'App')
      )
        appExport = true;
    }
  }
  let usesKit = false;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      throw invalidSource('dynamic_import_not_allowed', file, node);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      if (components.has(tag) || namespaces.has(tag.split('.')[0])) usesKit = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!appExport) throw invalidSource('app_export_missing');
  if (!usesKit) throw invalidSource('uikit_component_not_rendered');
  return source;
}

export function validateReactDesign(source) {
  validateReactSource(source);
  const ts = typescript();
  const file = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let switcher = false,
    layout = false;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        if (
          attribute.name.getText(file) === 'aria-label' &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === 'Варианты дизайна'
        )
          switcher = true;
        if (attribute.name.getText(file) === 'data-prototype-variant') layout = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!switcher || !layout)
    throw Object.assign(new Error('LIVE_MODEL_DESIGN_VARIANTS_MISSING'), {
      code: 'LIVE_MODEL_DESIGN_VARIANTS_MISSING',
      details: { reason: !switcher ? 'design_switcher_missing' : 'design_layout_marker_missing' },
      diagnostics: [
        !switcher
          ? 'React validation: design_switcher_missing'
          : 'React validation: design_layout_marker_missing',
      ],
    });
  return source;
}

export function validateFinalReactDesign(source) {
  validateReactSource(source);
  const ts = typescript();
  const file = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function visit(node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === 'aria-label' &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === 'Варианты дизайна'
    ) {
      throw Object.assign(new Error('LIVE_MODEL_FINAL_VARIANT_INVALID'), {
        code: 'LIVE_MODEL_FINAL_VARIANT_INVALID',
        details: { reason: 'final_design_switcher_present' },
        diagnostics: ['React validation: final_design_switcher_present'],
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return source;
}
