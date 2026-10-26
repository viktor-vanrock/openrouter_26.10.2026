import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function transpileTypescript() {
  return {
    name: 'transpile-typescript',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null;
      const candidate = path.resolve(path.dirname(importer), source);
      for (const file of [`${candidate}.ts`, path.join(candidate, 'index.ts')]) {
        if (fs.existsSync(file)) return file;
      }
      return null;
    },
    transform(code, id) {
      if (!id.endsWith('.ts')) return null;
      const result = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      });
      return { code: result.outputText, map: result.sourceMapText ?? null };
    },
  };
}

export default {
  input: 'src/index.ts',
  output: { dir: 'dist', format: 'esm', sourcemap: true },
  external: (id) => !id.startsWith('.') && !id.startsWith('/'),
  plugins: [transpileTypescript()],
};
