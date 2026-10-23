import { NextFunction, Request, Response, json } from 'express';
import { parse, print, visit } from 'graphql';
import { normalizeAddress } from '../../../modules/web3/addresses';

// Case-insensitive so camelCase arguments such as tokenAddress match too.
// `id` is anchored so chainId and similar fields are left alone.
const LOWER_REGEX =
    /(^id$|^idin$|^idnotin$|poolid|address|tokensin|tokensnotin|tokeninin|tokenoutin|tokenin|tokenout)/i;

const UPPER_REGEX = /categories/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function normalizeQueryValue(value: string): string {
    if (EVM_ADDRESS.test(value)) return normalizeAddress(value);
    return value.toLowerCase();
}

// Recursively convert values of poolId, address, id to lowercase
// Used when passing variables to queries
const convertLetterCase = (obj: Record<string, any>) => {
    for (let key in obj) {
        if (typeof obj[key] === 'string' && LOWER_REGEX.test(key)) {
            obj[key] = normalizeQueryValue(obj[key]);
        } else if (typeof obj[key] === 'string' && UPPER_REGEX.test(key)) {
            obj[key] = obj[key].toUpperCase();
        } else if (Array.isArray(obj[key]) && LOWER_REGEX.test(key)) {
            obj[key] = obj[key].map((item: string) => normalizeQueryValue(item));
        } else if (Array.isArray(obj[key]) && UPPER_REGEX.test(key)) {
            obj[key] = obj[key].map((item: string) => item.toUpperCase());
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            convertLetterCase(obj[key]);
        }
    }
};

const casedQueryParams = (query: string): string => {
    // Parse the query into an AST
    const ast = parse(query);

    // Visit each node in the AST
    const modifiedAst = visit(ast, {
        ObjectField(node) {
            if (node.value.kind === 'ListValue' && LOWER_REGEX.test(node.name.value)) {
                const values = node.value.values.map((value) => {
                    if (value.kind === 'StringValue') {
                        return {
                            ...value,
                            value: normalizeQueryValue(value.value),
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
            } else if (node.value.kind === 'ListValue' && UPPER_REGEX.test(node.name.value)) {
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
        },
        Argument(node) {
            if (LOWER_REGEX.test(node.name.value)) {
                if (node.value.kind === 'StringValue') {
                    // Convert the argument value to lowercase
                    const value = normalizeQueryValue(node.value.value);
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
                                value: normalizeQueryValue(value.value),
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
            } else if (UPPER_REGEX.test(node.name.value)) {
                if (node.value.kind === 'StringValue') {
                    // Convert the argument value to lowercase
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

    // Convert the modified AST back to a query string
    return print(modifiedAst);
};

/**
 * Middleware that normalizes address arguments before they reach case-sensitive database filters.
 * A 20-byte address is checksum-checked and stored lowercase. A bad checksum is rejected.
 *
 * @param req The request object
 * @param res The response object
 * @param next The next function
 */
export async function lowerCaseMiddleware(req: Request, res: Response, next: NextFunction) {
    json()(req, res, (err) => {
        if (req.method === 'POST' && req.is('application/json') && req.body) {
            try {
                const { query, variables } = req.body;

                if (variables) {
                    convertLetterCase(variables);
                }

                if (query) {
                    // Replacing the original query with the lowercase one
                    req.body.query = casedQueryParams(query);
                }
            } catch (error) {
                return next(error);
            }
        }

        next();
    });
}
