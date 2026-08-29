import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(packageRoot, 'src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

function packageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) return null
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  return specifier.split('/').slice(0, 2).join('/')
}

function importedPackages(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []

  function addSpecifier(node: ts.Expression | undefined): void {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text)
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addSpecifier(node.moduleReference.expression)
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) addSpecifier(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return specifiers
    .map(packageName)
    .filter((name): name is string => name !== null)
}

describe('published dependency contract', () => {
  it('declares every package imported by production source', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string>>
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    const imported = sourceFiles(sourceRoot).flatMap(importedPackages)
    const undeclared = [...new Set(imported.filter((name) => !declared.has(name)))].sort()

    expect(undeclared).toEqual([])
  })
})
