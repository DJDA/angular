/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AotCompilerHost, StaticSymbol} from '@angular/compiler';
import {AngularCompilerOptions, MetadataCollector, ModuleMetadata} from '@angular/tsc-wrapped';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const EXT = /(\.ts|\.d\.ts|\.js|\.jsx|\.tsx)$/;
const DTS = /\.d\.ts$/;
const NODE_MODULES = '/node_modules/';
const IS_GENERATED = /\.(ngfactory|css(\.shim)?)$/;

export interface NgHostContext {
  fileExists(fileName: string): boolean;
  directoryExists(directoryName: string): boolean;
  readFile(fileName: string): string;
  readResource(fileName: string): Promise<string>;
  assumeFileExists(fileName: string): void;
}

export class NgHost implements AotCompilerHost {
  protected metadataCollector = new MetadataCollector();
  protected context: NgHostContext;
  private isGenDirChildOfRootDir: boolean;
  protected basePath: string;
  private genDir: string;
  constructor(
      protected program: ts.Program, protected compilerHost: ts.CompilerHost,
      protected options: AngularCompilerOptions, context?: NgHostContext) {
    // normalize the path so that it never ends with '/'.
    this.basePath = path.normalize(path.join(this.options.basePath, '.')).replace(/\\/g, '/');
    this.genDir = path.normalize(path.join(this.options.genDir, '.')).replace(/\\/g, '/');

    this.context = context || new NodeNgHostContext(compilerHost);
    const genPath: string = path.relative(this.basePath, this.genDir);
    this.isGenDirChildOfRootDir = genPath === '' || !genPath.startsWith('..');
  }

  // We use absolute paths on disk as canonical.
  getCanonicalFileName(fileName: string): string { return fileName; }

  resolveImportToFile(m: string, containingFile: string) {
    if (!containingFile || !containingFile.length) {
      if (m.indexOf('.') === 0) {
        throw new Error('Resolution of relative paths requires a containing file.');
      }
      // Any containing file gives the same result for absolute imports
      containingFile = path.join(this.basePath, 'index.ts');
    }
    m = m.replace(EXT, '');
    const resolved =
        ts.resolveModuleName(m, containingFile.replace(/\\/g, '/'), this.options, this.context)
            .resolvedModule;
    return resolved ? resolved.resolvedFileName : null;
  };

  /**
   * We want a moduleId that will appear in import statements in the generated code.
   * These need to be in a form that system.js can load, so absolute file paths don't work.
   *
   * The `containingFile` is always in the `genDir`, where as the `importedFile` can be in
   * `genDir`, `node_module` or `basePath`.  The `importedFile` is either a generated file or
   * existing file.
   *
   *               | genDir   | node_module |  rootDir
   * --------------+----------+-------------+----------
   * generated     | relative |   relative  |   n/a
   * existing file |   n/a    |   absolute  |  relative(*)
   *
   * NOTE: (*) the relative path is computed depending on `isGenDirChildOfRootDir`.
   */
  resolveFileToImport(importedFile: string, containingFile: string): string {
    // If a file does not yet exist (because we compile it later), we still need to
    // assume it exists it so that the `resolve` method works!
    if (!this.compilerHost.fileExists(importedFile)) {
      this.context.assumeFileExists(importedFile);
    }

    containingFile = this.rewriteGenDirPath(containingFile);
    const containingDir = path.dirname(containingFile);
    // drop extension
    importedFile = importedFile.replace(EXT, '');

    const nodeModulesIndex = importedFile.indexOf(NODE_MODULES);
    const importModule = nodeModulesIndex === -1 ?
        null :
        importedFile.substring(nodeModulesIndex + NODE_MODULES.length);
    const isGeneratedFile = IS_GENERATED.test(importedFile);

    if (isGeneratedFile) {
      // rewrite to genDir path
      if (importModule) {
        // it is generated, therefore we do a relative path to the factory
        return this.dotRelative(containingDir, this.genDir + NODE_MODULES + importModule);
      } else {
        // assume that import is also in `genDir`
        importedFile = this.rewriteGenDirPath(importedFile);
        return this.dotRelative(containingDir, importedFile);
      }
    } else {
      // user code import
      if (importModule) {
        return importModule;
      } else {
        if (!this.isGenDirChildOfRootDir) {
          // assume that they are on top of each other.
          importedFile = importedFile.replace(this.basePath, this.genDir);
        }
        return this.dotRelative(containingDir, importedFile);
      }
    }
  }

  private dotRelative(from: string, to: string): string {
    const rPath: string = path.relative(from, to).replace(/\\/g, '/');
    return rPath.startsWith('.') ? rPath : './' + rPath;
  }

  /**
   * Moves the path into `genDir` folder while preserving the `node_modules` directory.
   */
  private rewriteGenDirPath(filepath: string) {
    const nodeModulesIndex = filepath.indexOf(NODE_MODULES);
    if (nodeModulesIndex !== -1) {
      // If we are in node_modulse, transplant them into `genDir`.
      return path.join(this.genDir, filepath.substring(nodeModulesIndex));
    } else {
      // pretend that containing file is on top of the `genDir` to normalize the paths.
      // we apply the `genDir` => `rootDir` delta through `rootDirPrefix` later.
      return filepath.replace(this.basePath, this.genDir);
    }
  }

  private resolverCache = new Map<string, ModuleMetadata>();

  getMetadataFor(filePath: string): ModuleMetadata {
    if (!this.context.fileExists(filePath)) {
      // If the file doesn't exists then we cannot return metadata for the file.
      // This will occur if the user refernced a declared module for which no file
      // exists for the module (i.e. jQuery or angularjs).
      return;
    }
    if (DTS.test(filePath)) {
      const metadataPath = filePath.replace(DTS, '.metadata.json');
      if (this.context.fileExists(metadataPath)) {
        const metadata = this.readMetadata(metadataPath);
        return (Array.isArray(metadata) && metadata.length == 0) ? undefined : metadata;
      }
    } else {
      const sf = this.program.getSourceFile(filePath);
      if (!sf) {
        if (this.context.fileExists(filePath)) {
          const sourceText = this.context.readFile(filePath);
          return this.metadataCollector.getMetadata(
              ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true));
        }

        throw new Error(`Source file ${filePath} not present in program.`);
      }
      return this.metadataCollector.getMetadata(sf);
    }
  }

  readMetadata(filePath: string) {
    try {
      return this.resolverCache.get(filePath) || JSON.parse(this.context.readFile(filePath));
    } catch (e) {
      console.error(`Failed to read JSON file ${filePath}`);
      throw e;
    }
  }

  loadResource(filePath: string): Promise<string> { return this.context.readResource(filePath); }

  private getResolverMetadata(filePath: string): ModuleMetadata {
    let metadata = this.resolverCache.get(filePath);
    if (!metadata) {
      metadata = this.getMetadataFor(filePath);
      this.resolverCache.set(filePath, metadata);
    }
    return metadata;
  }
}

export class NodeNgHostContext implements NgHostContext {
  constructor(private host: ts.CompilerHost) {}

  private assumedExists: {[fileName: string]: boolean} = {};

  fileExists(fileName: string): boolean {
    return this.assumedExists[fileName] || this.host.fileExists(fileName);
  }

  directoryExists(directoryName: string): boolean {
    try {
      return fs.statSync(directoryName).isDirectory();
    } catch (e) {
      return false;
    }
  }

  readFile(fileName: string): string { return fs.readFileSync(fileName, 'utf8'); }

  readResource(s: string) {
    if (!this.host.fileExists(s)) {
      // TODO: We should really have a test for error cases like this!
      throw new Error(`Compilation failed. Resource file not found: ${s}`);
    }
    return Promise.resolve(this.host.readFile(s));
  }

  assumeFileExists(fileName: string): void { this.assumedExists[fileName] = true; }
}