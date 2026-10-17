import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  constants,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  DEFAULT_CREDENTIAL_FILES,
  wildcard,
} from '../../../../src/approvals.ts';

export interface WorkspaceDocument {
  /** Stable across reads, saves and refreshes of the same workspace path. */
  id: string;
  /** A workspace-relative path, never an untrusted renderer-provided absolute path. */
  path: string;
  content: string;
  revision: string;
  mtime: number;
  size: number;
}

export interface WorkspaceDocumentChange {
  path: string;
  /** null deletes an existing file after checking its revision. */
  content: string | null;
  /** null explicitly means that the file must not exist yet. */
  expectedRevision: string | null;
}

export interface WorkspaceDocumentEdit extends WorkspaceDocumentChange {
  content: string;
}

export interface WorkspaceFileEntry {
  id: string;
  path: string;
  mtime: number;
  size: number;
}

export interface WorkspaceFilesSnapshot {
  version: number;
  files: WorkspaceFileEntry[];
  changes: {
    kind: 'added' | 'changed' | 'removed';
    file: WorkspaceFileEntry;
  }[];
  truncated: boolean;
}

export interface WorkspaceEditFailure {
  path: string;
  kind: 'conflict' | 'cancelled' | 'invalid' | 'io';
  message: string;
  /** Present on a revision conflict; null means the file was deleted. */
  current?: WorkspaceDocument | null;
}

export interface WorkspaceChangeResult {
  status: 'applied' | 'rejected' | 'partial';
  applied: WorkspaceDocument[];
  /** Includes a replacement even if reading its resulting document failed. */
  committedPaths: string[];
  failures: WorkspaceEditFailure[];
  /** Inputs not committed, including the failed input. Safe to present for recovery. */
  remaining: WorkspaceDocumentChange[];
}

export interface WorkspaceEditResult extends WorkspaceChangeResult {
  remaining: WorkspaceDocumentEdit[];
}

export interface WorkspaceDocumentsOptions {
  credentialFiles?: string[];
  maxBytes?: number;
  maxFiles?: number;
  maxDepth?: number;
  ignoredDirectories?: string[];
}

const TORN_READ_ATTEMPTS = 5;
const TORN_READ_PAUSE_MS = 20;
export class TornReadError extends Error {}

export class DocumentConflictError extends Error {
  readonly code = 'DOCUMENT_CONFLICT';
  constructor(
    readonly path: string,
    readonly expectedRevision: string | null,
    readonly current: WorkspaceDocument | null,
  ) {
    super(`file changed on disk: ${path}`);
    this.name = 'DocumentConflictError';
  }
}

export class DocumentPathError extends Error {
  readonly code = 'DOCUMENT_PATH_DENIED';
}

const ignoredDirectories = [
  '.git',
  'node_modules',
  '.circle',
  '.venv',
  'dist',
  'build',
  'coverage',
];
const rootQueues = new Map<string, Promise<void>>();
const decode = new TextDecoder('utf-8', { fatal: true });

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * File access for an already granted workspace. The main process owns this
 * instance; callers still validate their workspace grant before selecting it.
 * All in-process writers sharing this root serialize their compare-and-save.
 */
export class WorkspaceDocuments {
  readonly root: string;
  private readonly rootIdentity: string;
  private readonly options: Required<WorkspaceDocumentsOptions>;
  private identities = new Map<string, string>();
  private indexed = new Map<
    string,
    { file: WorkspaceFileEntry; stamp: string }
  >();
  private version = 0;
  private indexedTruncated = false;
  private catalogQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<{
    next: (snapshot: WorkspaceFilesSnapshot) => void;
    error?: (error: Error) => void;
    version: number;
  }>();
  private watcher?: FSWatcher;
  private poll?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private watchRefresh?: Promise<void>;
  private closed = false;

  constructor(root: string, options: WorkspaceDocumentsOptions = {}) {
    // Use the same OS resolver as fs.promises.realpath() in target(). The JS
    // resolver can retain Windows 8.3 names that the native resolver expands.
    this.root = realpathSync.native(resolve(root));
    const info = statSync(this.root, { bigint: true });
    if (!info.isDirectory())
      throw new DocumentPathError('workspace is not a folder');
    this.rootIdentity = `${info.dev}:${info.ino}`;
    this.options = {
      credentialFiles: [
        ...DEFAULT_CREDENTIAL_FILES,
        ...(options.credentialFiles ?? []),
      ],
      maxBytes: options.maxBytes ?? 4_000_000,
      maxFiles: options.maxFiles ?? 2000,
      maxDepth: options.maxDepth ?? 12,
      ignoredDirectories: options.ignoredDirectories ?? ignoredDirectories,
    };
  }

  /** Keep a cached workspace service aligned with saved approval settings. */
  setCredentialFiles(patterns: string[]): void {
    this.options.credentialFiles = [...DEFAULT_CREDENTIAL_FILES, ...patterns];
  }

  private async serial<T>(
    run: () => Promise<T>,
    signal?: AbortSignal,
    mutationQueue = true,
  ): Promise<T> {
    if (this.closed) throw Error('workspace documents are closed');
    signal?.throwIfAborted();
    const previous = mutationQueue
      ? (rootQueues.get(this.root) ?? Promise.resolve())
      : this.catalogQueue;
    let release!: () => void;
    const next = new Promise<void>((done) => {
      release = done;
    });
    if (mutationQueue) rootQueues.set(this.root, next);
    else this.catalogQueue = next;
    await previous;
    try {
      if (this.closed) throw Error('workspace documents are closed');
      signal?.throwIfAborted();
      const info = await lstat(this.root, { bigint: true });
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        `${info.dev}:${info.ino}` !== this.rootIdentity
      )
        throw new DocumentPathError(
          'selected workspace moved; grant the folder again',
        );
      return await run();
    } finally {
      release();
      if (mutationQueue && rootQueues.get(this.root) === next)
        rootQueues.delete(this.root);
    }
  }

  private async target(
    raw: string,
    allowMissing = false,
  ): Promise<{ full: string; path: string }> {
    if (
      !raw ||
      raw.includes('\0') ||
      raw.includes('\\') ||
      isAbsolute(raw) ||
      /^[A-Za-z]:/.test(raw)
    )
      throw new DocumentPathError('use a workspace-relative file path');
    const parts = raw.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..'))
      throw new DocumentPathError('path traversal not allowed');
    // Check every spelling, not just the real target: aliases must never hide a
    // credential or expose the repository's internal state as an editable file.
    for (const part of parts) {
      // The default macOS volume is case-insensitive, although the sandbox's
      // pattern matcher only folds case on Windows. Do not let .ENV or .GIT
      // spelling variants extend this native workspace grant.
      const foldCase =
        process.platform === 'darwin' || process.platform === 'win32';
      const folded = foldCase ? part.toLowerCase() : part;
      if (
        folded === '.git' ||
        folded === '.circle' ||
        this.options.credentialFiles.some((pattern) =>
          wildcard(foldCase ? pattern.toLowerCase() : pattern, folded),
        )
      )
        throw new DocumentPathError(
          `file is not available in this workspace: ${part}`,
        );
    }
    let current = this.root;
    let existingParent = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new DocumentPathError('symbolic link was not granted');
        if (index < parts.length - 1 && !info.isDirectory())
          throw new DocumentPathError('file parent is not a folder');
        if (index < parts.length - 1) existingParent = current;
      } catch (error) {
        if (!(allowMissing && missing(error))) throw error;
      }
    }
    const parent = await realpath(existingParent);
    const local = relative(this.root, parent);
    if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local))
      throw new DocumentPathError('file moved outside the selected workspace');
    return { full: current, path: parts.join('/') };
  }

  private identity(path: string): string {
    let id = this.identities.get(path);
    if (!id) {
      id = randomUUID();
      this.identities.set(path, id);
    }
    return id;
  }

  // What a save just put on disk. Another program can write the file between
  // our rename and this read. Reporting its version as ours would let the
  // editor take that write for the saved file and overwrite it on the next
  // save. Then describe our own write with a revision no read can produce: the
  // next read shows the change, and a save before it meets a conflict.
  private async readWritten(
    full: string,
    path: string,
    content: string,
  ): Promise<WorkspaceDocument> {
    const written = decode.decode(Buffer.from(content, 'utf8'));
    try {
      const document = await this.readTarget(full, path);
      if (document.content === written) return document;
    } catch (error) {
      if (!(error instanceof TornReadError)) throw error;
    }
    return {
      id: this.identity(path),
      path,
      content: written,
      revision: createHash('sha256')
        .update(`overwritten:${randomUUID()}:`)
        .update(written)
        .digest('hex'),
      mtime: Date.now(),
      size: Buffer.byteLength(written, 'utf8'),
    };
  }

  // A file written while it is read (by the agent, a formatter or Git) gives a
  // torn read. Read it again a few times before telling the person, since the
  // next read normally sees the whole new file.
  private async readTarget(
    full: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readTargetOnce(full, path, signal);
      } catch (error) {
        if (!(error instanceof TornReadError) || attempt >= TORN_READ_ATTEMPTS)
          throw error;
        await delay(TORN_READ_PAUSE_MS * attempt, undefined, { signal });
      }
    }
  }

  private async readTargetOnce(
    full: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument> {
    signal?.throwIfAborted();
    const handle = await open(
      full,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new DocumentPathError('not a regular file');
      if (before.nlink > 1n)
        throw new DocumentPathError('hard-linked files were not granted');
      if (before.size > BigInt(this.options.maxBytes))
        throw Error('file is too large to edit');
      const bytes = await handle.readFile({ signal });
      if (bytes.length > this.options.maxBytes)
        throw Error('file is too large to edit');
      const after = await handle.stat({ bigint: true });
      if (
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.size !== after.size
      )
        throw new TornReadError(
          `file changed while reading: ${path}; read it again`,
        );
      const content = decode.decode(bytes);
      if (content.includes('\0'))
        throw Error('binary files cannot be edited as text');
      const revision = createHash('sha256')
        .update(
          `${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}:${after.size}:`,
        )
        .update(bytes)
        .digest('hex');
      return {
        id: this.identity(path),
        path,
        content,
        revision,
        mtime: Number(after.mtimeMs),
        size: bytes.length,
      };
    } finally {
      await handle.close();
    }
  }

  async read(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceDocument> {
    return this.serial(async () => {
      const target = await this.target(path);
      return this.readTarget(target.full, target.path, options.signal);
    }, options.signal);
  }

  private async current(
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument | null> {
    const target = await this.target(path, true);
    try {
      return await this.readTarget(target.full, target.path, signal);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  /** Preparation-time read, including an explicit missing-file version. */
  async snapshot(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceDocument | null> {
    return this.serial(
      () => this.current(path, options.signal),
      options.signal,
    );
  }

  private async check(
    edit: WorkspaceDocumentChange,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument | null> {
    if (
      (edit.content !== null && typeof edit.content !== 'string') ||
      (edit.expectedRevision !== null &&
        typeof edit.expectedRevision !== 'string')
    )
      throw Error('content and expected revision are required');
    if (
      edit.content !== null &&
      (Buffer.byteLength(edit.content) > this.options.maxBytes ||
        edit.content.includes('\0'))
    )
      throw Error('content is too large or is binary');
    const current = await this.current(edit.path, signal);
    if ((current?.revision ?? null) !== edit.expectedRevision)
      throw new DocumentConflictError(
        edit.path,
        edit.expectedRevision,
        current,
      );
    if (edit.content === null && current === null)
      throw Error('cannot delete a missing file');
    return current;
  }

  private async stage(
    edit: WorkspaceDocumentEdit,
    signal?: AbortSignal,
  ): Promise<{ full: string; temporary: string }> {
    const { full } = await this.target(edit.path, true);
    await mkdir(dirname(full), { recursive: true });
    await this.target(edit.path, true);
    const temporary = join(
      dirname(full),
      `.circle-document-${randomUUID()}.tmp`,
    );
    const originalMode = await stat(full).then(
      (info) => info.mode & 0o777,
      (error) => {
        if (missing(error)) return undefined;
        throw error;
      },
    );
    const handle = await open(temporary, 'wx', originalMode ?? 0o600);
    try {
      await handle.writeFile(edit.content, { encoding: 'utf8', signal });
      // Creation applies umask. Reapply only an existing file's mode; new files
      // must retain the user's creation mask rather than gaining permissions.
      if (originalMode !== undefined) await handle.chmod(originalMode);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    return { full, temporary };
  }

  async save(
    path: string,
    content: string,
    expectedRevision: string | null,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceDocument> {
    return this.serial(async () => {
      const edit = { path, content, expectedRevision };
      await this.check(edit, options.signal);
      const staged = await this.stage(edit, options.signal);
      try {
        // External programs do not share our queue. Re-check after staging, as
        // close to the atomic replacement as the filesystem permits.
        await this.check(edit, options.signal);
        options.signal?.throwIfAborted();
        await rename(staged.temporary, staged.full);
        return await this.readWritten(staged.full, path, content);
      } finally {
        await rm(staged.temporary, { force: true });
      }
    }, options.signal);
  }

  async applyEdits(
    edits: WorkspaceDocumentEdit[],
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceEditResult> {
    return this.applyChanges(edits, options) as Promise<WorkspaceEditResult>;
  }

  async applyChanges(
    edits: WorkspaceDocumentChange[],
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceChangeResult> {
    return this.serial(async () => {
      const applied: WorkspaceDocument[] = [];
      const committedPaths: string[] = [];
      const staged: { full: string; temporary?: string }[] = [];
      let result: WorkspaceChangeResult | undefined;
      let active = 0;
      try {
        if (new Set(edits.map((edit) => edit.path)).size !== edits.length)
          throw new DocumentPathError('a batch may edit each file only once');
        // Validate every document before creating staging files or changing one.
        for (const [index, edit] of edits.entries()) {
          active = index;
          await this.check(edit, options.signal);
        }
        for (const [index, edit] of edits.entries()) {
          active = index;
          staged.push(
            edit.content === null
              ? { full: (await this.target(edit.path)).full }
              : await this.stage(
                  { ...edit, content: edit.content },
                  options.signal,
                ),
          );
        }
        for (const [index, edit] of edits.entries()) {
          active = index;
          await this.check(edit, options.signal);
        }
        for (const [index, edit] of edits.entries()) {
          active = index;
          await this.check(edit, options.signal);
          options.signal?.throwIfAborted();
          if (edit.content === null) await unlink(staged[index]!.full);
          else await rename(staged[index]!.temporary!, staged[index]!.full);
          committedPaths.push(edit.path);
          // Once replacement happened, report it even if cancellation arrives.
          if (edit.content !== null)
            applied.push(
              await this.readWritten(
                staged[index]!.full,
                edit.path,
                edit.content,
              ),
            );
        }
        result = {
          status: 'applied',
          applied,
          committedPaths,
          failures: [],
          remaining: [],
        };
        return result;
      } catch (error) {
        const failure: WorkspaceEditFailure = {
          path: edits[active]?.path ?? '',
          kind:
            error instanceof DocumentConflictError
              ? 'conflict'
              : options.signal?.aborted
                ? 'cancelled'
                : error instanceof DocumentPathError
                  ? 'invalid'
                  : 'io',
          message: errorMessage(error),
          ...(error instanceof DocumentConflictError
            ? { current: error.current }
            : {}),
        };
        const committed = new Set(committedPaths);
        result = {
          status: committedPaths.length ? 'partial' : 'rejected',
          applied,
          committedPaths,
          failures: [failure],
          remaining: edits.filter((edit) => !committed.has(edit.path)),
        };
        return result;
      } finally {
        const cleanup = await Promise.allSettled(
          staged.map(({ temporary }) =>
            temporary ? rm(temporary, { force: true }) : Promise.resolve(),
          ),
        );
        for (const [index, outcome] of cleanup.entries()) {
          if (outcome.status !== 'rejected') continue;
          if (!result) throw outcome.reason;
          result.status = committedPaths.length ? 'partial' : 'rejected';
          result.failures.push({
            path: relative(this.root, staged[index]!.full).split(sep).join('/'),
            kind: 'io',
            message: `could not remove staged file ${basename(staged[index]!.temporary!)}: ${errorMessage(outcome.reason)}`,
          });
        }
      }
    }, options.signal);
  }

  async refresh(
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceFilesSnapshot> {
    return this.serial(
      async () => {
        const indexed = new Map<
          string,
          { file: WorkspaceFileEntry; stamp: string }
        >();
        let truncated = false;
        const walk = async (folder: string, depth: number): Promise<void> => {
          options.signal?.throwIfAborted();
          if (depth > this.options.maxDepth) {
            truncated = true;
            return;
          }
          if (folder !== this.root)
            await this.target(relative(this.root, folder).split(sep).join('/'));
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            if (indexed.size >= this.options.maxFiles) {
              truncated = true;
              break;
            }
            if (
              entry.isSymbolicLink() ||
              entry.name.startsWith('.circle-document-')
            )
              continue;
            const path = relative(this.root, join(folder, entry.name))
              .split(sep)
              .join('/');
            if (entry.isDirectory()) {
              if (!this.options.ignoredDirectories.includes(entry.name)) {
                try {
                  await walk(join(folder, entry.name), depth + 1);
                } catch (error) {
                  if (!(error instanceof DocumentPathError) && !missing(error))
                    throw error;
                }
              }
            } else if (entry.isFile()) {
              try {
                const target = await this.target(path);
                const info = await lstat(target.full, { bigint: true });
                if (!info.isFile() || info.nlink > 1n) continue;
                const file = {
                  id: this.identity(path),
                  path,
                  mtime: Number(info.mtimeMs),
                  size: Number(info.size),
                };
                indexed.set(path, {
                  file,
                  stamp: `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`,
                });
              } catch (error) {
                if (!(error instanceof DocumentPathError) && !missing(error))
                  throw error;
              }
            }
          }
        };
        await walk(this.root, 0);
        const changes: WorkspaceFilesSnapshot['changes'] = [];
        for (const [path, value] of indexed) {
          const previous = this.indexed.get(path);
          if (!previous || previous.stamp !== value.stamp)
            changes.push({
              kind: previous ? 'changed' : 'added',
              file: value.file,
            });
        }
        for (const [path, value] of this.indexed)
          if (!indexed.has(path))
            changes.push({ kind: 'removed', file: value.file });
        this.indexed = indexed;
        if (
          changes.length ||
          this.version === 0 ||
          this.indexedTruncated !== truncated
        )
          this.version++;
        this.indexedTruncated = truncated;
        const snapshot = {
          version: this.version,
          files: [...indexed.values()]
            .map(({ file }) => file)
            .sort((a, b) => a.path.localeCompare(b.path)),
          changes,
          truncated,
        };
        for (const listener of this.listeners) {
          if (listener.version === snapshot.version) continue;
          listener.version = snapshot.version;
          try {
            listener.next(structuredClone(snapshot));
          } catch {
            /* One consumer cannot break another subscription. */
          }
        }
        return snapshot;
      },
      options.signal,
      false,
    );
  }

  watch(
    next: (snapshot: WorkspaceFilesSnapshot) => void,
    options: {
      signal?: AbortSignal;
      onError?: (error: Error) => void;
      pollIntervalMs?: number;
    } = {},
  ): { ready: Promise<WorkspaceFilesSnapshot>; close: () => void } {
    if (this.closed) throw Error('workspace documents are closed');
    const listener = { next, error: options.onError, version: -1 };
    this.listeners.add(listener);
    const close = () => {
      this.listeners.delete(listener);
      options.signal?.removeEventListener('abort', close);
      if (!this.listeners.size) this.stopWatching();
    };
    options.signal?.addEventListener('abort', close, { once: true });
    if (options.signal?.aborted) close();
    if (this.listeners.size && !this.poll) {
      const refresh = () => {
        // A slow scan must not accumulate one queued scan per poll interval.
        if (this.watchRefresh) return;
        this.watchRefresh = this.refresh()
          .then(() => undefined)
          .catch((error) => {
            this.notifyError(
              error instanceof Error ? error : Error(String(error)),
            );
          })
          .finally(() => {
            this.watchRefresh = undefined;
          });
      };
      try {
        this.watcher = watch(
          this.root,
          { recursive: true, persistent: false },
          () => {
            clearTimeout(this.debounce);
            this.debounce = setTimeout(refresh, 40);
            this.debounce.unref();
          },
        );
        this.watcher.on('error', (error) => {
          this.notifyError(error);
          this.watcher?.close();
          this.watcher = undefined;
        });
      } catch {
        /* Polling is also needed for dropped or unsupported native events. */
      }
      this.poll = setInterval(
        refresh,
        Math.max(40, options.pollIntervalMs ?? 1000),
      );
      this.poll.unref();
    }
    return { ready: this.refresh({ signal: options.signal }), close };
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.poll);
    this.poll = undefined;
    clearTimeout(this.debounce);
    this.debounce = undefined;
  }

  private notifyError(error: Error): void {
    for (const subscriber of this.listeners) {
      try {
        subscriber.error?.(error);
      } catch {
        /* Isolate consumer callbacks. */
      }
    }
  }

  close(): void {
    this.closed = true;
    this.stopWatching();
    this.listeners.clear();
  }
}
