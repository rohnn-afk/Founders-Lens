import { z } from 'zod';
import { generation } from '../generation/contracts.js';
import { acceptanceRef, messageCreate, messageDto, transcriptQuery } from '../submission/contracts.js';
import { conversationCreate, conversationDto, ideaCreate, ideaDetailsPatch, ideaDto, idempotencyKey, listQuery, uuid } from '../workspace/contracts.js';
import { workspacePrefix, type RegisteredOperation } from './routes.js';

const tags = ['Health', 'Ideas', 'Conversations', 'Messages', 'Generation', 'Memory', 'Research'] as const;
type Tag = typeof tags[number];
type Schema = Record<string, unknown>;
const schema = (contract: z.ZodType): Schema => {
  const json = z.toJSONSchema(contract, { io: 'input' });
  delete json.$schema;
  return json;
};
const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const time = '2026-01-01T00:00:00.000Z';
const idea = { id, title: 'Synthetic study planner', status: 'ACTIVE', version: 1, createdAt: time, updatedAt: time };
const conversation = { id: otherId, ideaId: id, status: 'ACTIVE', proactiveResearch: false, version: 1, createdAt: time };
const message = { id, conversationId: otherId, sequence: 1, role: 'USER', content: 'Compare two study schedules.', createdAt: time };
const page = { hasMore: false, nextCursor: null };
const listIdeaDto = ideaDto.extend({ status: ideaDto.shape.status.extract(['ACTIVE', 'ARCHIVED']) });
const activeIdeaDto = ideaDto.extend({ status: z.literal('ACTIVE') });
const activeConversationDto = conversationDto.extend({ status: z.literal('ACTIVE') });
const savedMessageDto = messageDto.extend({ role: z.literal('USER') });

function pageOf(item: z.ZodType) {
  return z.strictObject({ items: z.array(item), page: z.strictObject({ hasMore: z.boolean(), nextCursor: z.string().nullable() }) });
}

function json(schema: Schema, example: unknown) {
  return { 'application/json': { schema, example } };
}

function success(contract: z.ZodType, example: unknown, description = 'Successful response') {
  return { description, content: json(schema(contract), example) };
}

function parameter(name: string, location: 'path' | 'query' | 'header', description: string, shape: Schema, example?: unknown) {
  return { name, in: location, required: location !== 'query', description, schema: shape, example };
}

const key = parameter('Idempotency-Key', 'header', 'Send exactly one key. Reuse it only for a retry of the same request.', schema(idempotencyKey), 'example-retry-key');
const listLimit = parameter('limit', 'query', 'Decimal digits representing a page size from 1 to 100.', {
  ...schema(listQuery.shape.limit), default: '25', description: 'Numeric value must be between 1 and 100.'
}, '25');
const workspaceQuery = [listLimit, parameter('cursor', 'query', 'Opaque continuation from the preceding page. Scoped to the signed-in account and collection.', schema(listQuery.shape.cursor))];
const messagesQuery = [listLimit, parameter('cursor', 'query', 'Opaque continuation scoped to the account, conversation and page size.', schema(transcriptQuery.shape.cursor)),
  parameter('assistantResponseVersion', 'query', 'Version 1 returns text. Version 2 is accepted but returns 503 because the structured projection is unavailable.',
    { ...schema(transcriptQuery.shape.assistantResponseVersion), default: '1' }, '1')];
const body = (shape: Schema, example: unknown, limit: string) => ({
  required: true, description: 'Strict JSON object. Maximum body size is ' + limit + '.', content: json(shape, example)
});
const ideaBody = body(schema(ideaCreate), { title: idea.title }, '64 KiB');
const conversationBody = body(schema(conversationCreate), { title: 'First planning session', proactiveResearch: false }, '64 KiB');
const messageBody = body(schema(messageCreate), { clientSubmissionId: otherId, content: message.content }, '128 KiB');
const textRule = 'Text must be well-formed Unicode and cannot contain NUL. Length limits count Unicode code points.';
const workspacePaging = 'Ordered by most recently updated first with descending ID as the tie-breaker. Pass page.nextCursor unchanged to continue when page.hasMore is true. The final page has a null cursor.';
const transcriptPaging = 'Ordered by logical turn, with user text before assistant text. Pass page.nextCursor unchanged with the same limit. The final page has a null cursor.';

const errorContract = z.strictObject({ error: z.strictObject({
  code: z.string(), message: z.string(), requestId: uuid, retryable: z.boolean()
}) });
const errors = {
  400: ['VALIDATION_ERROR', 'Invalid path, query, header or body.', false],
  401: ['UNAUTHENTICATED', 'Authentication is required.', false],
  403: ['ACCOUNT_UNAVAILABLE', 'The account is unavailable. A disallowed browser origin receives an empty 403.', false],
  404: ['RESOURCE_NOT_FOUND', 'The requested resource is unavailable or outside the caller’s authorized scope. Some route restrictions return an empty 404.', false],
  409: ['IDEMPOTENCY_KEY_REUSED', 'An idempotency key or submission identifier conflicts with a prior intent, or a generation is already in progress.', false],
  412: ['PRECONDITION_FAILED', 'The idea version changed. Reload before editing again.', false],
  413: ['PAYLOAD_TOO_LARGE', 'The request body is too large.', false],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'The request must contain JSON.', false],
  428: ['PRECONDITION_REQUIRED', 'The current idea version is required.', false],
  429: ['QUOTA_EXCEEDED', 'The submission quota is exhausted.', false],
  500: ['INTERNAL_ERROR', 'An internal error occurred.', false],
  503: ['DEPENDENCY_UNAVAILABLE', 'A required dependency, clearance or projection is unavailable.', true]
} as const;
const baseErrors = [400, 401, 403, 500, 503] as const;

type Operation = {
  operationId: string;
  tag: Tag;
  summary: string;
  description: string;
  responses: Record<string, { description: string; content?: ReturnType<typeof json>; headers?: Record<string, unknown> }>;
  parameters?: ReturnType<typeof parameter>[];
  requestBody?: ReturnType<typeof body>;
  extraErrors?: (keyof typeof errors)[];
};
const generationPath = workspacePrefix + '/generations/' + id;
const reference = { messageId: id, generationId: id, statusUrl: generationPath, eventsUrl: generationPath + '/events' };
const links = acceptanceRef.extend({ statusUrl: z.string(), eventsUrl: z.string() });
const eventNote = 'The returned events URL is reserved for streaming and is unavailable in this API composition.';
const location = { Location: { description: 'Relative resource URL.', schema: { type: 'string' } } };

const catalog: Record<string, Operation> = {
  'get /health/live': {
    operationId: 'getLiveness', tag: 'Health', summary: 'Check process liveness',
    description: 'Reports whether the HTTP process is serving traffic. The response body is empty.',
    responses: { 200: { description: 'Process is serving HTTP.' } }
  },
  'get /health/ready': {
    operationId: 'getReadiness', tag: 'Health', summary: 'Check workspace readiness',
    description: 'Checks the configured runtime dependencies and current authority clearance. The response body is empty.',
    responses: { 200: { description: 'Runtime is ready.' }, 503: { description: 'Readiness is unconfigured or a runtime check failed.' } }
  },
  'get /ideas': {
    operationId: 'listIdeas', tag: 'Ideas', summary: 'List owned ideas', description: workspacePaging,
    parameters: workspaceQuery, extraErrors: [404], responses: { 200: success(pageOf(listIdeaDto), { items: [idea], page }) }
  },
  'post /ideas': {
    operationId: 'createIdea', tag: 'Ideas', summary: 'Create an idea',
    description: 'Create an owned idea with idempotent retries. The title must contain a non-whitespace character. ' + textRule,
    parameters: [key], requestBody: ideaBody, extraErrors: [409, 413, 415],
    responses: { 201: { ...success(listIdeaDto, idea, 'Idea created or original result replayed.'), headers: {
      ...location, ETag: { description: 'Current version validator.', schema: { type: 'string' }, example: '"v1"' }
    } } }
  },
  'get /ideas/:ideaId': {
    operationId: 'getIdea', tag: 'Ideas', summary: 'Read an owned idea', description: 'Returns the current projection of an owned active idea.',
    extraErrors: [404], responses: { 200: success(activeIdeaDto, idea) }
  },
  'patch /ideas/:ideaId': {
    operationId: 'editIdea', tag: 'Ideas', summary: 'Edit an owned idea',
    description: 'Update the title or summary of an active idea. A title must contain a non-whitespace character. Send null to clear the summary. ' + textRule,
    parameters: [parameter('If-Match', 'header', 'Strong version validator from the current idea.', { type: 'string', pattern: '^"v[0-9]+"$' }, '"v1"')],
    requestBody: body(schema(ideaDetailsPatch), { title: 'Revised study planner' }, '64 KiB'),
    extraErrors: [404, 412, 413, 415, 428],
    responses: { 200: { ...success(activeIdeaDto, { ...idea, version: 2 }), headers: {
      ETag: { description: 'Updated version validator.', schema: { type: 'string' }, example: '"v2"' }
    } } }
  },
  'get /ideas/:ideaId/conversations': {
    operationId: 'listConversations', tag: 'Conversations', summary: 'List conversations for an owned idea',
    description: 'Lists active conversations for an active idea. ' + workspacePaging, parameters: workspaceQuery, extraErrors: [404],
    responses: { 200: { ...success(pageOf(activeConversationDto), { items: [conversation], page }), headers: {
      'X-Workspace-Conversation-Creation': { description: 'Present when the local conversation creation route is admitted.',
        schema: { type: 'string', enum: ['enabled'] } }
    } } }
  },
  'post /ideas/:ideaId/conversations': {
    operationId: 'createConversation', tag: 'Conversations', summary: 'Create a conversation',
    description: 'Creates a conversation under the owned idea. Each successful request creates a conversation. ' + textRule,
    requestBody: conversationBody, extraErrors: [404, 413, 415], responses: { 201: success(activeConversationDto, conversation) }
  },
  'get /conversations/:conversationId': {
    operationId: 'getConversation', tag: 'Conversations', summary: 'Read an owned conversation',
    description: 'Returns an active conversation in an active idea after checking account and parent access.',
    extraErrors: [404], responses: { 200: { ...success(activeConversationDto, conversation), headers: {
      'X-Workspace-Message-Save': { description: 'Present when the local save-only message route is admitted.',
        schema: { type: 'string', enum: ['enabled'] } }
    } } }
  },
  'get /conversations/:conversationId/messages': {
    operationId: 'listMessages', tag: 'Messages', summary: 'Read the conversation transcript',
    description: 'Returns the visible text for an active conversation in an active idea. ' + transcriptPaging, parameters: messagesQuery, extraErrors: [404],
    responses: { 200: success(pageOf(messageDto), { items: [message], page }) }
  },
  'post /conversations/:conversationId/messages/save': {
    operationId: 'saveMessage', tag: 'Messages', summary: 'Save a user message',
    description: 'Saves user text without enqueuing generation. Retry the same intent using the original key and submission ID. ' + textRule,
    parameters: [key], requestBody: messageBody, extraErrors: [404, 409, 413, 415], responses: { 201: success(savedMessageDto, message) }
  },
  'post /conversations/:conversationId/messages': {
    operationId: 'submitMessage', tag: 'Generation', summary: 'Submit a message for generation',
    description: 'Accepts a message and enqueues generation only for the admitted local account and synthetic conversation. Retry with the original key and submission ID. ' + textRule + ' ' + eventNote,
    parameters: [key], requestBody: messageBody, extraErrors: [404, 409, 413, 415, 429],
    responses: { 202: { ...success(links.extend({ status: z.literal('PENDING') }), { ...reference, status: 'PENDING' }), headers: location } }
  },
  'get /conversations/:conversationId/submissions/:clientSubmissionId': {
    operationId: 'getSubmission', tag: 'Generation', summary: 'Recover submission identifiers',
    description: 'Finds the accepted submission by its client ID in the admitted conversation. ' + eventNote,
    extraErrors: [404], responses: { 200: success(links.extend({ clientSubmissionId: uuid }), { ...reference, clientSubmissionId: otherId }) }
  },
  'get /generations/:generationId': {
    operationId: 'getGeneration', tag: 'Generation', summary: 'Read generation status',
    description: 'Returns the current status of an authorized generation within the admitted local conversation.',
    extraErrors: [404], responses: { 200: success(generation, {
      id, conversationId: otherId, triggerMessageId: id, status: 'PENDING', selected: false, createdAt: time
    }) }
  }
};

export function openApi(health: readonly RegisteredOperation[], workspace: readonly RegisteredOperation[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  const usedTags = new Set<Tag>();
  for (const { routes, prefix } of [{ routes: health, prefix: '' }, { routes: workspace, prefix: workspacePrefix }]) {
    for (const { method, path } of routes) {
      const operation = catalog[method + ' ' + path];
      if (!operation) throw new Error('Missing API documentation for ' + method + ' ' + path);
      const { tag, parameters, extraErrors, description, responses, ...fields } = operation;
      usedTags.add(tag);
      const protectedRoute = prefix === workspacePrefix;
      const template = prefix + path.replace(/:(\w+)/g, '{$1}');
      const pathParameters = [...path.matchAll(/:(\w+)/g)].map(([, name]) =>
        parameter(name!, 'path', 'Resource identifier in UUID format.', schema(uuid), id));
      const failures = protectedRoute ? Object.fromEntries([...baseErrors, ...extraErrors ?? []].map(status => {
        const [code, message, retryable] = errors[status];
        return [status, { description: message, content: json(schema(errorContract), { error: { code, message, requestId: id, retryable } }) }];
      })) : {};
      const pathItem = paths[template] ??= {};
      pathItem[method] = {
        ...fields, tags: [tag], description: description + (protectedRoute && !parameters?.some(param => param.in === 'query')
          ? ' Query parameters are rejected.' : ''),
        security: protectedRoute ? [{ ClerkBearer: [] }] : [],
        parameters: [...pathParameters, ...parameters ?? []], responses: { ...responses, ...failures }
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Founder’s Lens API', version: '1.0.0', description: 'Operations mounted in this API runtime. Examples use synthetic data.' },
    servers: [{ url: '/' }],
    tags: tags.filter(name => usedTags.has(name)).map(name => ({ name })),
    paths,
    components: { securitySchemes: { ClerkBearer: {
      type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
      description: 'Short-lived Clerk session token from the configured signed-in frontend. Account binding and authorization apply.'
    } } }
  };
}
