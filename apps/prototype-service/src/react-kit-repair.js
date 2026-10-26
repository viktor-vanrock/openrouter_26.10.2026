import ts from 'typescript';
import { PROTOTYPE_LAYOUT_COMPAT_CSS } from 'librechat-data-provider';

/** Narrow, deterministic repair for the kit's mutually exclusive icon props. */
export function repairButtonIcons(source) {
  const file = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const buttons = new Set();
  for (const node of file.statements) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === '@ai-sber/uikit' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const item of node.importClause.namedBindings.elements) {
        if ((item.propertyName ?? item.name).text === 'Button') buttons.add(item.name.text);
      }
    }
  }
  const edits = [];
  function visit(node) {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      buttons.has(node.tagName.getText(file))
    ) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const left = attrs.find((attr) => attr.name.getText(file) === 'leftIcon');
      if (left && attrs.some((attr) => attr.name.getText(file) === 'rightIcon')) {
        edits.push({ start: left.getStart(file), end: left.end, text: '' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!edits.length) return { source, changed: false };
  const uses = new Set();
  function references(node) {
    if (
      ts.isImportDeclaration(node) ||
      edits.some((edit) => node.pos >= edit.start && node.end <= edit.end)
    )
      return;
    if (ts.isIdentifier(node)) uses.add(node.text);
    ts.forEachChild(node, references);
  }
  references(file);
  for (const node of file.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !node.importClause?.namedBindings ||
      !ts.isNamedImports(node.importClause.namedBindings)
    )
      continue;
    const named = node.importClause.namedBindings;
    const kept = named.elements.filter((item) => uses.has(item.name.text));
    if (kept.length !== named.elements.length) {
      if (!kept.length && !node.importClause.name)
        edits.push({ start: node.getStart(file), end: node.end, text: '' });
      else
        edits.push({
          start: named.getStart(file),
          end: named.end,
          text: `{ ${kept.map((item) => item.getText(file)).join(', ')} }`,
        });
    }
  }
  let repaired = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    repaired = repaired.slice(0, edit.start) + edit.text + repaired.slice(edit.end);
  return { source: repaired, changed: true };
}

/** SearchInput has no id prop; use the kit Input for a label-bound search while preserving string callbacks. */
export function repairLabelBoundSearch(source) {
  const file = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set();
  let kitImport;
  for (const node of file.statements) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === '@ai-sber/uikit' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      kitImport = node;
      for (const item of node.importClause.namedBindings.elements) {
        if ((item.propertyName ?? item.name).text === 'SearchInput') names.add(item.name.text);
      }
    }
  }
  const alias = '__PrototypeSearchInput';
  if (!kitImport || source.includes(alias)) return { source, changed: false };
  const edits = [];
  const allowed = new Set(['id', 'value', 'onChange', 'placeholder', 'className', 'disabled']);
  function visit(node) {
    if (
      ts.isJsxSelfClosingElement(node) &&
      names.has(node.tagName.getText(file)) &&
      node.attributes.properties.every(
        (attr) => ts.isJsxAttribute(attr) && allowed.has(attr.name.getText(file)),
      )
    ) {
      const attrs = node.attributes.properties;
      const id = attrs.find((attr) => attr.name.getText(file) === 'id');
      const change = attrs.find((attr) => attr.name.getText(file) === 'onChange');
      if (id && change && ts.isJsxExpression(change.initializer) && change.initializer.expression) {
        edits.push({ start: node.tagName.getStart(file), end: node.tagName.end, text: alias });
        edits.push({
          start: change.getStart(file),
          end: change.end,
          text: `onChange={(event) => (${change.initializer.expression.getText(file)})(event.target.value)}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!edits.length) return { source, changed: false };
  const named = kitImport.importClause.namedBindings;
  edits.push({
    start: named.getStart(file),
    end: named.end,
    text: `{ ${named.elements.map((item) => item.getText(file)).join(', ')}, Input as ${alias} }`,
  });
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  // The original named SearchInput import can become unused under noUnusedLocals.
  const parsed = ts.createSourceFile(
    'App.tsx',
    result,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const referenced = new Set();
  function references(node) {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) referenced.add(node.text);
    ts.forEachChild(node, references);
  }
  references(parsed);
  const unused = [...names].filter((name) => !referenced.has(name));
  if (unused.length) {
    const imp = parsed.statements.find(
      (node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@ai-sber/uikit',
    );
    const bindings = imp.importClause.namedBindings;
    result =
      result.slice(0, bindings.getStart(parsed)) +
      `{ ${bindings.elements
        .filter((item) => !unused.includes(item.name.text))
        .map((item) => item.getText(parsed))
        .join(', ')} }` +
      result.slice(bindings.end);
  }
  return { source: result, changed: true };
}

export function repairUiKitSource(source) {
  const icons = repairButtonIcons(source);
  const search = repairLabelBoundSearch(icons.source);
  const modal = repairControlledModal(search.source);
  const unused = repairUnusedBindings(modal.source);
  const layout = repairPrototypeLayout(unused.source);
  return {
    source: layout.source,
    changed: icons.changed || search.changed || modal.changed || unused.changed || layout.changed,
  };
}

/** Include the same layout/contrast fix in offline HTML, not only in the chat iframe. */
export function repairPrototypeLayout(source) {
  if (source.includes('data-prototype-ui-compat')) return { source, changed: false };
  const file = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits = [];
  function isApp(node) {
    if (!node) return false;
    return (
      node?.name?.getText(file) === 'App' ||
      (ts.isArrowFunction(node) &&
        ts.isVariableDeclaration(node.parent) &&
        node.parent.name.getText(file) === 'App')
    );
  }
  function wrap(expression) {
    edits.push({
      start: expression.getStart(file),
      end: expression.end,
      text: `(<><style data-prototype-ui-compat>{${JSON.stringify(PROTOTYPE_LAYOUT_COMPAT_CSS)}}</style>{${expression.getText(file)}}</>)`,
    });
  }
  function visit(node) {
    if (ts.isReturnStatement(node) && node.expression) {
      const owner = enclosingFunction(node);
      if (isApp(owner)) wrap(node.expression);
    }
    if (ts.isArrowFunction(node) && isApp(node) && !ts.isBlock(node.body)) wrap(node.body);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return applyEdits(source, edits);
}

function compilerService(source) {
  const filename = 'App.tsx';
  const service = ts.createLanguageService({
    getCompilationSettings: () => ({
      noLib: true,
      noResolve: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    }),
    getScriptFileNames: () => [filename],
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) =>
      name === filename ? ts.ScriptSnapshot.fromString(source) : undefined,
    getCurrentDirectory: () => '.',
    getDefaultLibFileName: () => '',
    fileExists: (name) => name === filename,
    readFile: (name) => (name === filename ? source : undefined),
    readDirectory: () => [],
  });
  return { filename, service, file: service.getProgram().getSourceFile(filename) };
}

function applyEdits(source, edits) {
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return { source: result, changed: edits.length > 0 };
}
function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent)) return parent;
  return null;
}

/** Connect an existing, otherwise unused dialog controller; keep its explicit add/edit/reset handlers. */
export function repairControlledModal(source) {
  const { filename, service, file } = compilerService(source);
  try {
    const unused = service
      .getSemanticDiagnostics(filename)
      .filter((d) => d.code === 6133)
      .map((d) => d.start);
    const kitNames = new Map();
    for (const node of file.statements) {
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier.text === '@ai-sber/uikit' &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const binding of node.importClause.namedBindings.elements)
          kitNames.set((binding.propertyName ?? binding.name).text, binding.name.text);
      }
    }
    const modals = [],
      bindings = [],
      handlers = [];
    function visit(node) {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(file) === kitNames.get('Modal')
      )
        modals.push(node);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isArrayBindingPattern(node.name) &&
        node.name.elements.length === 2 &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        /^(?:React\.)?useState$/.test(node.initializer.expression.getText(file))
      )
        bindings.push(node);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'handleOpenModal' &&
        node.initializer &&
        ts.isArrowFunction(node.initializer) &&
        (node.initializer.parameters.length === 0 ||
          (node.initializer.parameters.length === 1 &&
            (node.initializer.parameters[0].questionToken ||
              node.initializer.parameters[0].initializer)))
      )
        handlers.push(node);
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (
      modals.length !== 1 ||
      handlers.length !== 1 ||
      enclosingFunction(modals[0]) !== enclosingFunction(handlers[0])
    )
      return { source, changed: false };
    const modal = modals[0],
      attrs = modal.openingElement.attributes.properties;
    if (
      attrs.some(
        (attr) =>
          !ts.isJsxAttribute(attr) ||
          ['open', 'defaultOpen', 'onOpenChange'].includes(attr.name.getText(file)),
      )
    )
      return { source, changed: false };
    const edits = [];
    for (const binding of bindings) {
      if (enclosingFunction(binding) !== enclosingFunction(modal)) continue;
      const [value, setter] = binding.name.elements;
      if (
        !ts.isBindingElement(value) ||
        !ts.isIdentifier(value.name) ||
        !unused.includes(value.name.getStart(file)) ||
        !ts.isBindingElement(setter) ||
        !ts.isIdentifier(setter.name)
      )
        continue;
      let setsOpen = false;
      function findSetter(node) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === setter.name.text &&
          node.arguments.length === 1 &&
          node.arguments[0].kind === ts.SyntaxKind.TrueKeyword
        )
          setsOpen = true;
        ts.forEachChild(node, findSetter);
      }
      findSetter(handlers[0]);
      if (!setsOpen) continue;
      const triggerButtons = [];
      function findTrigger(node) {
        if (
          ts.isJsxElement(node) &&
          node.openingElement.tagName.getText(file) === kitNames.get('ModalTrigger')
        ) {
          for (const child of node.children)
            if (
              ts.isJsxElement(child) &&
              child.openingElement.tagName.getText(file) === kitNames.get('Button') &&
              !child.openingElement.attributes.properties.some(
                (attr) => !ts.isJsxAttribute(attr) || attr.name.getText(file) === 'onClick',
              )
            )
              triggerButtons.push(child);
        }
        ts.forEachChild(node, findTrigger);
      }
      findTrigger(modal);
      if (triggerButtons.length !== 1) continue;
      const position = modal.openingElement.tagName.end;
      edits.push({
        start: position,
        end: position,
        text: ` open={${value.name.text}} onOpenChange={${setter.name.text}}`,
      });
      const buttonPosition = triggerButtons[0].openingElement.tagName.end;
      edits.push({
        start: buttonPosition,
        end: buttonPosition,
        text: ' onClick={() => handleOpenModal()}',
      });
      break;
    }
    return applyEdits(source, edits);
  } finally {
    service.dispose();
  }
}

/** Compiler-assisted cleanup of unused destructuring only; no statement/hook/function removal. */
export function repairUnusedBindings(source) {
  const { filename, service, file } = compilerService(source);
  try {
    const nodes = new Map();
    function visit(node) {
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name))
        nodes.set(node.name.getStart(file), node);
      ts.forEachChild(node, visit);
    }
    visit(file);
    const edits = [];
    for (const diagnostic of service
      .getSemanticDiagnostics(filename)
      .filter((d) => d.code === 6133)) {
      const binding = nodes.get(diagnostic.start);
      if (
        !binding ||
        binding.initializer ||
        binding.dotDotDotToken ||
        (binding.propertyName && ts.isComputedPropertyName(binding.propertyName)) ||
        binding.parent.elements.some(
          (element) => ts.isBindingElement(element) && element.dotDotDotToken,
        )
      )
        continue;
      const fixes = service.getCodeFixesAtPosition(
        filename,
        diagnostic.start,
        diagnostic.start + diagnostic.length,
        [6133],
        {},
        {},
      );
      const fix = fixes.find(
        (item) =>
          item.fixName === 'unusedIdentifier' &&
          item.changes.every((change) => change.textChanges.every((edit) => edit.newText === '')),
      );
      const changes = fix?.changes.flatMap((item) => item.textChanges) ?? [];
      if (
        !changes.length ||
        changes.some(
          (change) =>
            change.newText !== '' ||
            change.span.start < binding.parent.getStart(file) ||
            change.span.start + change.span.length > binding.parent.end,
        )
      )
        continue;
      for (const change of changes)
        edits.push({
          start: change.span.start,
          end: change.span.start + change.span.length,
          text: '',
        });
    }
    // Adjacent unused members can share comma deletion ranges.
    const merged = [];
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      const last = merged.at(-1);
      if (last && edit.start <= last.end) last.end = Math.max(last.end, edit.end);
      else merged.push({ ...edit });
    }
    const result = applyEdits(source, merged);
    if (
      ts.createSourceFile(filename, result.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        .parseDiagnostics.length
    ) {
      return { source, changed: false };
    }
    return result;
  } finally {
    service.dispose();
  }
}
