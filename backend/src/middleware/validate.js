/**
 * Express middleware factory: validates req.body against a zod schema
 * before a route handler ever sees it, replacing this project's
 * previous hand-rolled `validateXInput(body)` functions one at a time
 * (see SNAPORDER_STATUS.md — "no input validation library" was a
 * flagged gap; zod was the library asked for).
 *
 * Produces the SAME error shape those hand-rolled validators already
 * returned — `{ error: { code: 'INVALID_REQUEST', message, details:
 * [{ field, reason }] } }` — deliberately, so converting a route to
 * this doesn't change its API contract or break existing tests that
 * assert on that shape.
 *
 * On success, req.body is REPLACED with the parsed result (schema
 * defaults/coercions applied) — callers should read from req.body as
 * usual afterwards, not keep a reference to the pre-validation object.
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        reason: issue.message,
      }));
      return res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'One or more fields are invalid', details },
      });
    }
    req.body = result.data;
    next();
  };
}
