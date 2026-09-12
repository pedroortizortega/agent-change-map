/*
 * Vendored from jsdiff (https://github.com/kpdecker/jsdiff): the `diffLines` line-level
 * Myers diff algorithm, reduced to the single code path this module needs. The generic
 * `Diff` base class, its line-tokenizer, and its equality hook are inlined and stripped of
 * the callback/async execution mode, the `options` object, the word/char/JSON diff
 * subclasses, and the patch layer — none of which this module uses. The Myers path-search
 * (`diffTokens` below, corresponding to jsdiff's `Diff#diffWithOptionsObj`,
 * `Diff#extractCommon`, and `Diff#addToPath`) is a direct line-for-line port; only the
 * output shape (`DiffOp[]` with per-side line numbers) is specific to this project.
 *
 * jsdiff is distributed under the following license:
 *
 * BSD 3-Clause License
 *
 * Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

export type DiffOp =
  | { op: "unchanged"; leftLine: number; rightLine: number; text: string }
  | { op: "added"; rightLine: number; text: string }
  | { op: "removed"; leftLine: number; text: string };

interface DiffComponent {
  count: number;
  added: boolean;
  removed: boolean;
  previousComponent?: DiffComponent;
}

interface PathNode {
  oldPos: number;
  lastComponent?: DiffComponent;
}

/** Trailing-newline handling matches the previous `contentLines` helper: a single trailing empty line is dropped. */
function tokenizeLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function extractCommon(basePath: PathNode, newTokens: string[], oldTokens: string[], diagonalPath: number): number {
  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  let oldPos = basePath.oldPos;
  let newPos = oldPos - diagonalPath;
  let commonCount = 0;
  while (newPos + 1 < newLen && oldPos + 1 < oldLen && oldTokens[oldPos + 1] === newTokens[newPos + 1]) {
    newPos++;
    oldPos++;
    commonCount++;
  }
  if (commonCount) {
    basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
  }
  basePath.oldPos = oldPos;
  return newPos;
}

function addToPath(path: PathNode, added: boolean, removed: boolean, oldPosInc: number): PathNode {
  const last = path.lastComponent;
  if (last && last.added === added && last.removed === removed) {
    return { oldPos: path.oldPos + oldPosInc, lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent } };
  }
  return { oldPos: path.oldPos + oldPosInc, lastComponent: { count: 1, added, removed, previousComponent: last } };
}

function buildComponents(lastComponent: DiffComponent | undefined): DiffComponent[] {
  const components: DiffComponent[] = [];
  let current = lastComponent;
  while (current) {
    components.push(current);
    current = current.previousComponent;
  }
  components.reverse();
  return components;
}

/** O(ND) Myers diff over two already-tokenized line arrays, ported from jsdiff's `Diff#diffWithOptionsObj`. */
function diffTokens(oldTokens: string[], newTokens: string[]): DiffComponent[] {
  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  const bestPath = new Map<number, PathNode>();
  bestPath.set(0, { oldPos: -1, lastComponent: undefined });
  let newPos = extractCommon(bestPath.get(0)!, newTokens, oldTokens, 0);
  if (bestPath.get(0)!.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
    return buildComponents(bestPath.get(0)!.lastComponent);
  }

  let minDiagonalToConsider = -Infinity;
  let maxDiagonalToConsider = Infinity;
  let editLength = 1;
  const maxEditLength = newLen + oldLen;

  while (editLength <= maxEditLength) {
    for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
      const removePath = bestPath.get(diagonalPath - 1);
      const addPath = bestPath.get(diagonalPath + 1);
      if (removePath) bestPath.delete(diagonalPath - 1);

      let canAdd = false;
      if (addPath) {
        const addPathNewPos = addPath.oldPos - diagonalPath;
        canAdd = addPathNewPos >= 0 && addPathNewPos < newLen;
      }
      const canRemove = !!removePath && removePath.oldPos + 1 < oldLen;
      if (!canAdd && !canRemove) {
        bestPath.delete(diagonalPath);
        continue;
      }

      let basePath: PathNode;
      if (!canRemove || (canAdd && removePath!.oldPos < addPath!.oldPos)) {
        basePath = addToPath(addPath!, true, false, 0);
      } else {
        basePath = addToPath(removePath!, false, true, 1);
      }

      newPos = extractCommon(basePath, newTokens, oldTokens, diagonalPath);
      if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
        return buildComponents(basePath.lastComponent);
      }
      bestPath.set(diagonalPath, basePath);
      if (basePath.oldPos + 1 >= oldLen) maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
      if (newPos + 1 >= newLen) minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
    }
    editLength++;
  }
  // Unreachable for finite inputs: maxEditLength bounds the loop above and every path
  // terminates once both token arrays are fully consumed.
  return buildComponents(undefined);
}

export function diffLines(left: string, right: string, offsets: { leftStartLine: number; rightStartLine: number }): DiffOp[] {
  const oldTokens = tokenizeLines(left);
  const newTokens = tokenizeLines(right);
  const components = diffTokens(oldTokens, newTokens);
  const ops: DiffOp[] = [];
  let oldPos = 0;
  let newPos = 0;
  for (const component of components) {
    for (let i = 0; i < component.count; i++) {
      if (component.removed) {
        ops.push({ op: "removed", leftLine: offsets.leftStartLine + oldPos, text: oldTokens[oldPos]! });
        oldPos++;
      } else if (component.added) {
        ops.push({ op: "added", rightLine: offsets.rightStartLine + newPos, text: newTokens[newPos]! });
        newPos++;
      } else {
        ops.push({ op: "unchanged", leftLine: offsets.leftStartLine + oldPos, rightLine: offsets.rightStartLine + newPos, text: oldTokens[oldPos]! });
        oldPos++;
        newPos++;
      }
    }
  }
  return ops;
}
