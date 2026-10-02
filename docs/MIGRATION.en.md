# Migration file

[English](MIGRATION.en.md) · [Español](MIGRATION.md)

A JSON or YAML migration file records **confirmed decisions**. The initial format uses schemaVersion "1.0" and four required lists. The CLI validates shape, version, and duplicates; the planner also checks that target operations and fields exist in the new API and that an editable consumer use is present.

    schemaVersion: "1.0"
    allowedOrigins:
      - http://127.0.0.1:4010
    operations:
      - from: "operation_<OLD_ID>"
        to: "operation_<NEW_ID>"
    renames:
      - operationId: "operation_<NEW_POST_USERS_ID>"
        location: request
        from: name
        to: displayName
      - operationId: "operation_<NEW_ID>"
        location: query
        from: locale
        to: lang
      - operationId: "operation_<NEW_ID>"
        location: response
        from: fullName
        to: displayName
      - operationId: "operation_<NEW_ID>"
        location: response
        parent: [address]
        from: city
        to: town
    values:
      - operationId: "operation_<NEW_POST_USERS_ID>"
        location: request
        name: tenantId
        value: demo-tenant
      - operationId: "operation_<NEW_POST_ORDERS_ID>"
        location: request
        parent: [shipping, address]
        name: country
        value: ES

Replace angle-bracket placeholders with operation IDs from the analysis report. operations.from refers to the old API; operations.to refers to the new API. renames.operationId and values.operationId refer to the destination operation. When path and method stay the same, both IDs are equal. Stable operation IDs use the operation_ prefix. allowedOrigins lists exact HTTP(S) origins without paths or credentials; it limits where mappings may apply and does not verify production.

An operation mapping authorizes a route change only for an unambiguous use. renames permits a query key, a request-object key, or a direct response-property access when the AST provides an unambiguous edit range. values adds an explicitly configured required value. The optional parent (request and response only) is the property path of the object that holds the key; only that leaf key changes. It applies to nested inline request objects, response property chains such as data.address.city (including optional chaining) and const/let destructuring of the response, and the planner rejects paths it cannot verify through plain object schemas (arrays, oneOf/anyOf, additionalProperties, recursion). APIPatch never infers semantic equivalence from similar names.

Duplicate source operations, unknown properties, or an origin with a path are rejected. A valid file can still leave pending work for dynamic URLs, wrappers, or non-editable bindings. See the executable [synthetic demo mapping](../demo/migration.yaml) and [exported artifacts](../examples/demo/README.md).
