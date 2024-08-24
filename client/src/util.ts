const staticAssertionResults = new Map<String, string>();

/// Check a static assertion expression only once. The assertion does not depend on development vs. production.
export function staticAssertOnce(assertionUuid: string, expr: () => void) {
  let cachedRes: string | undefined = staticAssertionResults.get(assertionUuid);
  let res: string;
  if (cachedRes === undefined) {
    try {
      expr();
      res = ''; // no error
    } catch (e) {
      // String must be non-empty to count as failure, so always prefix it
      res = `Assertion failed: ${e}`;
    }
    staticAssertionResults.set(assertionUuid, res);
  } else {
    res = cachedRes;
  }

  if (res != '') {
    throw new Error(res);
  }
}
