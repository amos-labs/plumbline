/**
 * Minimal glob matcher supporting `*` (within a path segment) and `**`
 * (across segments). No dependency needed for this subset.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` or `**`
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchesAny(path: string, globs: string[]): string | null {
  for (const g of globs) {
    if (globToRegExp(g).test(path)) return g;
  }
  return null;
}
