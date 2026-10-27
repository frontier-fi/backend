import { NextFunction, Request, Response, json } from 'express';
import { GraphQLError, parse, print, visit } from 'graphql';
import { InvalidAddressError, normalizeAddress } from '../../../modules/web3/addresses';
import { MAX_TOKENS } from '../apollo/armor';

// Case-insensitive so camelCase arguments such as tokenAddress match too.
// `id` is anchored so chainId and similar fields are left alone.
const LOWER_REGEX =
    /(^id$|^idin$|^idnotin$|poolid|address|tokensin|tokensnotin|tokeninin|tokenoutin|tokenin|tokenout)/i;
const ADDRESS_REGEX = /(address|tokensin|tokensnotin|tokeninin|tokenoutin|tokenin|tokenout)/i;

const UPPER_REGEX = /categories/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function normalizeQueryValue(value: string, fieldName?: string): string {
    if ((fieldName && ADDRESS_REGEX.test(fieldName)) || EVM_ADDRESS.test(value)) {
        return normalizeAddress(value);
    }
    return value.toLowerCase();
}

function normalizeVariableValue(value: unknown, fieldName: string): unknown {
    if (typeof value === 'string') {
        return UPPER_REGEX.test(fieldName) ? value.toUpperCase() : normalizeQueryValue(value, fieldName);
    }
    if (Array.isArray(value)) {
        return value.map((item) =>
            typeof item === 'string'
                ? UPPER_REGEX.test(fieldName)
                    ? item.toUpperCase()
                    : normalizeQueryValue(item, fieldName)
                : item,
        );
    }
    return value;
}

// Recursively convert values of poolId, address, id to lowercase
// Used when passing variables to queries
const convertLetterCase = (obj: Record<string, any>) => {
    for (const key in obj) {
        if (typeof obj[key] === 'string' && LOWER_REGEX.test(key)) {
            obj[key] = normalizeQueryValue(obj[key], key);
        } else if (typeof obj[key] === 'string' && UPPER_REGEX.test(key)) {
            obj[key] = obj[key].toUpperCase();
        } else if (Array.isArray(obj[key]) && LOWER_REGEX.test(key)) {
            obj[key] = obj[key].map((item: unknown) =>
                typeof item === 'string' ? normalizeQueryValue(item, key) : item,
            );
        } else if (Array.isArray(obj[key]) && UPPER_REGEX.test(key)) {
            obj[key] = obj[key].map((item: unknown) => (typeof item === 'string' ? item.toUpperCase() : item));
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            convertLetterCase(obj[key]);
        }
    }
};

function recordReferencedVariables(
    valueNode: { kind: string; name?: { value: string }; values?: readonly any[] },
    fieldName: string,
    variableFields: Map<string, string>,
) {
    if (valueNode.kind === 'Variable' && valueNode.name?.value) {
        variableFields.set(valueNode.name.value, fieldName);
    } else if (valueNode.kind === 'ListValue' && valueNode.values) {
        for (const item of valueNode.values) {
            if (item.kind === 'Variable' && item.name?.value) {
                variableFields.set(item.name.value, fieldName);
            }
        }
    }
}

const casedQueryParams = (query: string, variables?: Record<string, unknown>): string => {
    // Parse the query into an AST
    const ast = parse(query, { maxTokens: MAX_TOKENS });
    const variableFields = new Map<string, string>();

    // Visit each node in the AST
    const modifiedAst = visit(ast, {
        ObjectField(node) {
            const fieldName = node.name.value;
            if (LOWER_REGEX.test(fieldName)) {
                recordReferencedVariables(node.value, fieldName, variableFields);
                if (node.value.kind === 'StringValue') {
                    return {
                        ...node,
                        value: {
                            ...node.value,
                            value: normalizeQueryValue(node.value.value, fieldName),
                        },
                    };
                }
                if (node.value.kind === 'ListValue') {
                    const values = node.value.values.map((value) => {
                        if (value.kind === 'StringValue') {
                            return {
                                ...value,
                                value: normalizeQueryValue(value.value, fieldName),
                            };
                        }
                        return value;
                    });
                    return {
                        ...node,
                        value: {
                            ...node.value,
                            values,
                        },
                    };
                }
            } else if (UPPER_REGEX.test(fieldName)) {
                recordReferencedVariables(node.value, fieldName, variableFields);
                if (node.value.kind === 'ListValue') {
                    const values = node.value.values.map((value) => {
                        if (value.kind === 'StringValue') {
                            return {
                                ...value,
                                value: value.value.toUpperCase(),
                            };
                        }
                        return value;
                    });
                    return {
                        ...node,
                        value: {
                            ...node.value,
                            values,
                        },
                    };
                }
            }
        },
        Argument(node) {
            const fieldName = node.name.value;
            if (LOWER_REGEX.test(fieldName)) {
                recordReferencedVariables(node.value, fieldName, variableFields);
                if (node.value.kind === 'StringValue') {
                    const value = normalizeQueryValue(node.value.value, fieldName);
                    return {
                        ...node,
                        value: {
                            ...node.value,
                            value,
                        },
                    };
                } else if (node.value.kind === 'ListValue') {
                    const values = node.value.values.map((value) => {
                        if (value.kind === 'StringValue') {
                            return {
                                ...value,
                                value: normalizeQueryValue(value.value, fieldName),
                            };
                        }
                        return value;
                    });
                    return {
                        ...node,
                        value: {
                            ...node.value,
                            values,
                        },
                    };
                }
            } else if (UPPER_REGEX.test(fieldName)) {
                recordReferencedVariables(node.value, fieldName, variableFields);
                if (node.value.kind === 'StringValue') {
                    const value = node.value.value.toUpperCase();
                    return {
                        ...node,
                        value: {
                            ...node.value,
                            value,
                        },
                    };
                } else if (node.value.kind === 'ListValue') {
                    const values = node.value.values.map((value) => {
                        if (value.kind === 'StringValue') {
                            return {
                                ...value,
                                value: value.value.toUpperCase(),
                            };
                        }
                        return value;
                    });
                    return {
                        ...node,
                        value: {
                            ...node.value,
                            values,
                        },
                    };
                }
            }
            return node;
        },
    });

    if (variables && typeof variables === 'object') {
        for (const [varName, fieldName] of variableFields) {
            if (Object.hasOwn(variables, varName)) {
                variables[varName] = normalizeVariableValue(variables[varName], fieldName);
            }
        }
    }

    // Convert the modified AST back to a query string
    return print(modifiedAst);
};

/**
 * Middleware that normalizes address arguments before they reach case-sensitive database filters.
 * A 20-byte address is checksum-checked and stored lowercase. A bad checksum is answered with
 * a 400 BAD_USER_INPUT error before the request reaches Apollo.
 *
 * @param req The request object
 * @param res The response object
 * @param next The next function
 */
export async function lowerCaseMiddleware(req: Request, res: Response, next: NextFunction) {
    json()(req, res, (err) => {
        if (err) {
            return next(err);
        }

        if (req.method === 'POST' && req.is('application/json') && req.body) {
            try {
                const { query, variables } = req.body;

                if (variables && typeof variables === 'object') {
                    convertLetterCase(variables);
                }

                if (typeof query === 'string') {
                    // Replacing the original query with the lowercase one
                    req.body.query = casedQueryParams(
                        query,
                        variables && typeof variables === 'object' ? variables : undefined,
                    );
                }
            } catch (error) {
                if (error instanceof InvalidAddressError) {
                    res.status(400).json({ errors: [{ message: error.message, extensions: error.extensions }] });
                    return;
                }
                // A syntax error: leave the query as sent, so Apollo answers with GRAPHQL_PARSE_FAILED.
                if (error instanceof GraphQLError) {
                    return next();
                }
                return next(error);
            }
        }

        next();
    });
}
