import { GqlSorGetSwapPaths, QuerySorGetSwapPathsArgs, Resolvers } from '../generated-schema';
import { sorService } from '../../../../modules/sor/sor.service';
import {
    ArgumentNode,
    ASTNode,
    astFromValue,
    DocumentNode,
    FieldNode,
    FragmentDefinitionNode,
    GraphQLResolveInfo,
    Kind,
    OperationTypeNode,
    print,
    visit,
} from 'graphql';
import { env } from '../../../env';

const TIMEOUT = 15_000;

const handleSorCall = async (args: QuerySorGetSwapPathsArgs, abortController: AbortController) => {
    // Terminate after 15 seconds
    const abortTimeout = setTimeout(() => {
        abortController.abort();
    }, TIMEOUT);

    try {
        const response = await sorService.getSorSwapPaths(args, abortController.signal);
        clearTimeout(abortTimeout);
        return response;
    } catch (error: any) {
        clearTimeout(abortTimeout);
        if (error.name === 'SorAbortError') {
            throw new Error(`SOR Request aborted: The operation timed out after ${TIMEOUT / 1000} seconds.`);
        } else {
            throw new Error('SOR Request aborted: The operation was cancelled.');
        }
    }
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * Where to proxy SOR queries, or undefined to quote in this process. A URL that points back at
 * this process would proxy each query to itself until the timeout.
 */
export function sorProxyUrl(settings: {
    SOR_INSTANCE: boolean;
    SOR_SERVICE_URL?: string;
    PORT: number;
}): string | undefined {
    const { SOR_INSTANCE, SOR_SERVICE_URL, PORT } = settings;
    if (SOR_INSTANCE || !SOR_SERVICE_URL) {
        return undefined;
    }

    const target = new URL(SOR_SERVICE_URL);
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    if (LOOPBACK_HOSTS.has(target.hostname) && port === PORT) {
        console.warn(`SOR_SERVICE_URL ${SOR_SERVICE_URL} points at this API. Quoting swaps in this process.`);
        return undefined;
    }

    return SOR_SERVICE_URL;
}

const proxyUrl = sorProxyUrl(env);

const stripAliases = <T extends ASTNode>(node: T): T =>
    visit(node, {
        Field: { leave: (field) => (field.alias ? { ...field, alias: undefined } : undefined) },
    });

/**
 * The request forwarded to the SOR instance: only this field, with the client's selection, the
 * arguments as literals, and just the fragments and variables that selection uses. Aliases are
 * removed so the response keys are field names, which the API resolves the client's selection against.
 */
export function sorProxyRequest(
    info: GraphQLResolveInfo,
    args: object,
): { query: string; variables: Record<string, unknown> } {
    const selections = info.fieldNodes.flatMap((node) => node.selectionSet?.selections ?? []);

    const fragments = new Map<string, FragmentDefinitionNode>();
    const addFragmentsUsedBy = (node: ASTNode) => {
        visit(node, {
            FragmentSpread(spread) {
                const fragment = info.fragments[spread.name.value];
                if (fragment && !fragments.has(fragment.name.value)) {
                    fragments.set(fragment.name.value, fragment);
                    addFragmentsUsedBy(fragment);
                }
            },
        });
    };
    selections.forEach(addFragmentsUsedBy);

    const usedVariables = new Set<string>();
    for (const node of [...selections, ...fragments.values()]) {
        visit(node, {
            Variable(variable) {
                usedVariables.add(variable.name.value);
            },
        });
    }

    const argumentNodes: ArgumentNode[] = [];
    for (const argument of info.parentType.getFields()[info.fieldName].args) {
        if (!(argument.name in args)) continue;
        const value = astFromValue((args as Record<string, unknown>)[argument.name], argument.type);
        if (value) {
            argumentNodes.push({ kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: argument.name }, value });
        }
    }

    const field: FieldNode = {
        kind: Kind.FIELD,
        name: { kind: Kind.NAME, value: info.fieldName },
        arguments: argumentNodes,
        selectionSet: stripAliases({ kind: Kind.SELECTION_SET, selections }),
    };
    const document: DocumentNode = {
        kind: Kind.DOCUMENT,
        definitions: [
            {
                kind: Kind.OPERATION_DEFINITION,
                operation: OperationTypeNode.QUERY,
                name: { kind: Kind.NAME, value: 'SorProxy' },
                variableDefinitions: (info.operation.variableDefinitions ?? []).filter((definition) =>
                    usedVariables.has(definition.variable.name.value),
                ),
                selectionSet: { kind: Kind.SELECTION_SET, selections: [field] },
            },
            ...[...fragments.values()].map(stripAliases),
        ],
    };

    return {
        query: print(document),
        variables: Object.fromEntries([...usedVariables].map((name) => [name, info.variableValues[name]])),
    };
}

export async function proxySorRequest(
    url: string,
    args: QuerySorGetSwapPathsArgs,
    info: GraphQLResolveInfo,
    abortController: AbortController,
): Promise<GqlSorGetSwapPaths> {
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
    }, TIMEOUT);

    try {
        const { query, variables } = sorProxyRequest(info, args);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query, variables, operationName: 'SorProxy' }),
            signal: abortController.signal,
        });

        const responseData = (await response.json()) as {
            data?: { sorGetSwapPaths: GqlSorGetSwapPaths };
            errors?: { message: string }[];
        };

        if (responseData.errors || !responseData.data) {
            const error = responseData.errors?.map((e) => e.message).join(';') ?? 'no data';
            throw new Error(`Request failed: ${error}`);
        }

        return responseData.data.sorGetSwapPaths;
    } catch (error) {
        if (timedOut) {
            throw new Error(`Request aborted: The operation timed out after ${TIMEOUT / 1000} seconds.`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

const balancerSdkResolvers: Resolvers = {
    Query: {
        sorGetSwapPaths: async (parent, args, context, info) => {
            // Create AbortSignal from request
            const abortController = new AbortController();
            context.req.on('close', () => {
                abortController.abort();
            });

            if (!proxyUrl) {
                return handleSorCall(args, abortController);
            }

            return proxySorRequest(proxyUrl, args, info, abortController);
        },
    },
};

export default balancerSdkResolvers;
