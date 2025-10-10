import { N8nApiClient } from '../services/n8n-api-client';
import { getN8nApiConfig, getN8nApiConfigFromContext } from '../config/n8n-api';
import {
  Workflow,
  WorkflowNode,
  WorkflowConnection,
  ExecutionStatus,
  WebhookRequest,
  McpToolResponse,
  ExecutionFilterOptions,
  ExecutionMode
} from '../types/n8n-api';
import {
  validateWorkflowStructure,
  hasWebhookTrigger,
  getWebhookUrl
} from '../services/n8n-validation';
import {
  N8nApiError,
  N8nNotFoundError,
  getUserFriendlyErrorMessage,
  formatExecutionError,
  formatNoExecutionError
} from '../utils/n8n-errors';
import { logger } from '../utils/logger';
import { z } from 'zod';
import { WorkflowValidator } from '../services/workflow-validator';
import { EnhancedConfigValidator } from '../services/enhanced-config-validator';
import { NodeRepository } from '../database/node-repository';
import { InstanceContext, validateInstanceContext } from '../types/instance-context';
import { NodeTypeNormalizer } from '../utils/node-type-normalizer';
import { WorkflowAutoFixer, AutoFixConfig } from '../services/workflow-auto-fixer';
import { ExpressionFormatValidator } from '../services/expression-format-validator';
import { handleUpdatePartialWorkflow } from './handlers-workflow-diff';
import { telemetry } from '../telemetry';
import {
  createCacheKey,
  createInstanceCache,
  CacheMutex,
  cacheMetrics,
  withRetry,
  getCacheStatistics
} from '../utils/cache-utils';
import { processExecution } from '../services/execution-processor';
import { checkNpmVersion, formatVersionMessage } from '../utils/npm-version-checker';

// Singleton n8n API client instance (backward compatibility)
let defaultApiClient: N8nApiClient | null = null;
let lastDefaultConfigUrl: string | null = null;

// Mutex for cache operations to prevent race conditions
const cacheMutex = new CacheMutex();

// Instance-specific API clients cache with LRU eviction and TTL
const instanceClients = createInstanceCache<N8nApiClient>((client, key) => {
  // Clean up when evicting from cache
  logger.debug('Evicting API client from cache', {
    cacheKey: key.substring(0, 8) + '...' // Only log partial key for security
  });
});

/**
 * Get or create API client with flexible instance support
 * Supports both singleton mode (using environment variables) and instance-specific mode.
 * Uses LRU cache with mutex protection for thread-safe operations.
 *
 * @param context - Optional instance context for instance-specific configuration
 * @returns API client configured for the instance or environment, or null if not configured
 *
 * @example
 * // Using environment variables (singleton mode)
 * const client = getN8nApiClient();
 *
 * @example
 * // Using instance context
 * const client = getN8nApiClient({
 *   n8nApiUrl: 'https://customer.n8n.cloud',
 *   n8nApiKey: 'api-key-123',
 *   instanceId: 'customer-1'
 * });
 */
/**
 * Get cache statistics for monitoring
 * @returns Formatted cache statistics string
 */
export function getInstanceCacheStatistics(): string {
  return getCacheStatistics();
}

/**
 * Get raw cache metrics for detailed monitoring
 * @returns Raw cache metrics object
 */
export function getInstanceCacheMetrics() {
  return cacheMetrics.getMetrics();
}

/**
 * Clear the instance cache for testing or maintenance
 */
export function clearInstanceCache(): void {
  instanceClients.clear();
  cacheMetrics.recordClear();
  cacheMetrics.updateSize(0, instanceClients.max);
}

export function getN8nApiClient(context?: InstanceContext): N8nApiClient | null {
  // If context provided with n8n config, use instance-specific client
  if (context?.n8nApiUrl && context?.n8nApiKey) {
    // Validate context before using
    const validation = validateInstanceContext(context);
    if (!validation.valid) {
      logger.warn('Invalid instance context provided', {
        instanceId: context.instanceId,
        errors: validation.errors
      });
      return null;
    }
    // Create secure hash of credentials for cache key using memoization
    const cacheKey = createCacheKey(
      `${context.n8nApiUrl}:${context.n8nApiKey}:${context.instanceId || ''}`
    );

    // Check cache first
    if (instanceClients.has(cacheKey)) {
      cacheMetrics.recordHit();
      return instanceClients.get(cacheKey) || null;
    }

    cacheMetrics.recordMiss();

    // Check if already being created (simple lock check)
    if (cacheMutex.isLocked(cacheKey)) {
      // Wait briefly and check again
      const waitTime = 100; // 100ms
      const start = Date.now();
      while (cacheMutex.isLocked(cacheKey) && (Date.now() - start) < 1000) {
        // Busy wait for up to 1 second
      }
      // Check if it was created while waiting
      if (instanceClients.has(cacheKey)) {
        cacheMetrics.recordHit();
        return instanceClients.get(cacheKey) || null;
      }
    }

    const config = getN8nApiConfigFromContext(context);
    if (config) {
      // Sanitized logging - never log API keys
      logger.info('Creating instance-specific n8n API client', {
        url: config.baseUrl.replace(/^(https?:\/\/[^\/]+).*/, '$1'), // Only log domain
        instanceId: context.instanceId,
        cacheKey: cacheKey.substring(0, 8) + '...' // Only log partial hash
      });

      const client = new N8nApiClient(config);
      instanceClients.set(cacheKey, client);
      cacheMetrics.recordSet();
      cacheMetrics.updateSize(instanceClients.size, instanceClients.max);
      return client;
    }

    return null;
  }

  // Fall back to default singleton from environment
  logger.info('Falling back to environment configuration for n8n API client');
  const config = getN8nApiConfig();

  if (!config) {
    if (defaultApiClient) {
      logger.info('n8n API configuration removed, clearing default client');
      defaultApiClient = null;
      lastDefaultConfigUrl = null;
    }
    return null;
  }

  // Check if config has changed
  if (!defaultApiClient || lastDefaultConfigUrl !== config.baseUrl) {
    logger.info('n8n API client initialized from environment', { url: config.baseUrl });
    defaultApiClient = new N8nApiClient(config);
    lastDefaultConfigUrl = config.baseUrl;
  }

  return defaultApiClient;
}

/**
 * Helper to ensure API is configured
 * @param context - Optional instance context
 * @returns Configured API client
 * @throws Error if API is not configured
 */
function ensureApiConfigured(context?: InstanceContext): N8nApiClient {
  const client = getN8nApiClient(context);
  if (!client) {
    if (context?.instanceId) {
      throw new Error(`n8n API not configured for instance ${context.instanceId}. Please provide n8nApiUrl and n8nApiKey in the instance context.`);
    }
    throw new Error('n8n API not configured. Please set N8N_API_URL and N8N_API_KEY environment variables.');
  }
  return client;
}

// Zod schemas for input validation
const createWorkflowSchema = z.object({
  name: z.string(),
  nodes: z.array(z.any()),
  connections: z.record(z.any()),
  settings: z.object({
    executionOrder: z.enum(['v0', 'v1']).optional(),
    timezone: z.string().optional(),
    saveDataErrorExecution: z.enum(['all', 'none']).optional(),
    saveDataSuccessExecution: z.enum(['all', 'none']).optional(),
    saveManualExecutions: z.boolean().optional(),
    saveExecutionProgress: z.boolean().optional(),
    executionTimeout: z.number().optional(),
    errorWorkflow: z.string().optional(),
  }).optional(),
});

const updateWorkflowSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  nodes: z.array(z.any()).optional(),
  connections: z.record(z.any()).optional(),
  settings: z.any().optional(),
});

const listWorkflowsSchema = z.object({
  limit: z.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  projectId: z.string().optional(),
  excludePinnedData: z.boolean().optional(),
});

const validateWorkflowSchema = z.object({
  id: z.string(),
  options: z.object({
    validateNodes: z.boolean().optional(),
    validateConnections: z.boolean().optional(),
    validateExpressions: z.boolean().optional(),
    profile: z.enum(['minimal', 'runtime', 'ai-friendly', 'strict']).optional(),
  }).optional(),
});

const autofixWorkflowSchema = z.object({
  id: z.string(),
  applyFixes: z.boolean().optional().default(false),
  fixTypes: z.array(z.enum([
    'expression-format',
    'typeversion-correction',
    'error-output-config',
    'node-type-correction',
    'webhook-missing-path'
  ])).optional(),
  confidenceThreshold: z.enum(['high', 'medium', 'low']).optional().default('medium'),
  maxFixes: z.number().optional().default(50)
});

const triggerWebhookSchema = z.object({
  webhookUrl: z.string().url(),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(),
  data: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  waitForResponse: z.boolean().optional(),
});

const listExecutionsSchema = z.object({
  limit: z.number().min(1).max(100).optional(),
  cursor: z.string().optional(),
  workflowId: z.string().optional(),
  projectId: z.string().optional(),
  status: z.enum(['success', 'error', 'waiting']).optional(),
  includeData: z.boolean().optional(),
});

// Workflow Management Handlers

export async function handleCreateWorkflow(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const input = createWorkflowSchema.parse(args);

    // Proactively detect SHORT form node types (common mistake)
    const shortFormErrors: string[] = [];
    input.nodes?.forEach((node: any, index: number) => {
      if (node.type?.startsWith('nodes-base.') || node.type?.startsWith('nodes-langchain.')) {
        const fullForm = node.type.startsWith('nodes-base.')
          ? node.type.replace('nodes-base.', 'n8n-nodes-base.')
          : node.type.replace('nodes-langchain.', '@n8n/n8n-nodes-langchain.');
        shortFormErrors.push(
          `Node ${index} ("${node.name}") uses SHORT form "${node.type}". ` +
          `The n8n API requires FULL form. Change to "${fullForm}"`
        );
      }
    });

    if (shortFormErrors.length > 0) {
      telemetry.trackWorkflowCreation(input, false);
      return {
        success: false,
        error: 'Node type format error: n8n API requires FULL form node types',
        details: {
          errors: shortFormErrors,
          hint: 'Use n8n-nodes-base.* instead of nodes-base.* for standard nodes'
        }
      };
    }

    // Validate workflow structure (n8n API expects FULL form: n8n-nodes-base.*)
    const errors = validateWorkflowStructure(input);
    if (errors.length > 0) {
      // Track validation failure
      telemetry.trackWorkflowCreation(input, false);

      return {
        success: false,
        error: 'Workflow validation failed',
        details: { errors }
      };
    }

    // Create workflow (n8n API expects node types in FULL form)
    const workflow = await client.createWorkflow(input);

    // Track successful workflow creation
    telemetry.trackWorkflowCreation(workflow, true);

    return {
      success: true,
      data: workflow,
      message: `Workflow "${workflow.name}" created successfully with ID: ${workflow.id}`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: error.details as Record<string, unknown> | undefined
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflow(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    return {
      success: true,
      data: workflow
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflowDetails(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    // Get recent executions for this workflow
    const executions = await client.listExecutions({
      workflowId: id,
      limit: 10
    });
    
    // Calculate execution statistics
    const stats = {
      totalExecutions: executions.data.length,
      successCount: executions.data.filter(e => e.status === ExecutionStatus.SUCCESS).length,
      errorCount: executions.data.filter(e => e.status === ExecutionStatus.ERROR).length,
      lastExecutionTime: executions.data[0]?.startedAt || null
    };
    
    return {
      success: true,
      data: {
        workflow,
        executionStats: stats,
        hasWebhookTrigger: hasWebhookTrigger(workflow),
        webhookPath: getWebhookUrl(workflow)
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflowStructure(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    // Simplify nodes to just essential structure
    const simplifiedNodes = workflow.nodes.map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      position: node.position,
      disabled: node.disabled || false
    }));
    
    return {
      success: true,
      data: {
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        isArchived: workflow.isArchived,
        nodes: simplifiedNodes,
        connections: workflow.connections,
        nodeCount: workflow.nodes.length,
        connectionCount: Object.keys(workflow.connections).length
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetWorkflowMinimal(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const { id } = z.object({ id: z.string() }).parse(args);
    
    const workflow = await client.getWorkflow(id);
    
    return {
      success: true,
      data: {
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        isArchived: workflow.isArchived,
        tags: workflow.tags || [],
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleUpdateWorkflow(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const input = updateWorkflowSchema.parse(args);
    const { id, ...updateData } = input;

    // If nodes/connections are being updated, validate the structure
    if (updateData.nodes || updateData.connections) {
      // Always fetch current workflow for validation (need all fields like name)
      const current = await client.getWorkflow(id);
      const fullWorkflow = {
        ...current,
        ...updateData
      };

      // Validate workflow structure (n8n API expects FULL form: n8n-nodes-base.*)
      const errors = validateWorkflowStructure(fullWorkflow);
      if (errors.length > 0) {
        return {
          success: false,
          error: 'Workflow validation failed',
          details: { errors }
        };
      }
    }
    
    // Update workflow
    const workflow = await client.updateWorkflow(id, updateData);
    
    return {
      success: true,
      data: workflow,
      message: `Workflow "${workflow.name}" updated successfully`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: error.details as Record<string, unknown> | undefined
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleDeleteWorkflow(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const { id } = z.object({ id: z.string() }).parse(args);

    const deleted = await client.deleteWorkflow(id);

    return {
      success: true,
      data: deleted,
      message: `Workflow ${id} deleted successfully`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleListWorkflows(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const input = listWorkflowsSchema.parse(args || {});

    // Convert tags array to comma-separated string (n8n API format)
    const tagsParam = input.tags && input.tags.length > 0
      ? input.tags.join(',')
      : undefined;

    const response = await client.listWorkflows({
      limit: input.limit || 100,
      cursor: input.cursor,
      active: input.active,
      tags: tagsParam as any,  // API expects string, not array
      projectId: input.projectId,
      excludePinnedData: input.excludePinnedData ?? true
    });
    
    // Strip down workflows to only essential metadata
    const minimalWorkflows = response.data.map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      active: workflow.active,
      isArchived: workflow.isArchived,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      tags: workflow.tags || [],
      nodeCount: workflow.nodes?.length || 0
    }));

    return {
      success: true,
      data: {
        workflows: minimalWorkflows,
        returned: minimalWorkflows.length,
        nextCursor: response.nextCursor,
        hasMore: !!response.nextCursor,
        ...(response.nextCursor ? { 
          _note: "More workflows available. Use cursor to get next page." 
        } : {})
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleValidateWorkflow(
  args: unknown,
  repository: NodeRepository,
  context?: InstanceContext
): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const input = validateWorkflowSchema.parse(args);
    
    // First, fetch the workflow from n8n
    const workflowResponse = await handleGetWorkflow({ id: input.id });
    
    if (!workflowResponse.success) {
      return workflowResponse; // Return the error from fetching
    }
    
    const workflow = workflowResponse.data as Workflow;
    
    // Create validator instance using the provided repository
    const validator = new WorkflowValidator(repository, EnhancedConfigValidator);
    
    // Run validation
    const validationResult = await validator.validateWorkflow(workflow, input.options);
    
    // Format the response (same format as the regular validate_workflow tool)
    const response: any = {
      valid: validationResult.valid,
      workflowId: workflow.id,
      workflowName: workflow.name,
      summary: {
        totalNodes: validationResult.statistics.totalNodes,
        enabledNodes: validationResult.statistics.enabledNodes,
        triggerNodes: validationResult.statistics.triggerNodes,
        validConnections: validationResult.statistics.validConnections,
        invalidConnections: validationResult.statistics.invalidConnections,
        expressionsValidated: validationResult.statistics.expressionsValidated,
        errorCount: validationResult.errors.length,
        warningCount: validationResult.warnings.length
      }
    };
    
    if (validationResult.errors.length > 0) {
      response.errors = validationResult.errors.map(e => ({
        node: e.nodeName || 'workflow',
        nodeName: e.nodeName, // Also set nodeName for compatibility
        message: e.message,
        details: e.details
      }));
    }

    if (validationResult.warnings.length > 0) {
      response.warnings = validationResult.warnings.map(w => ({
        node: w.nodeName || 'workflow',
        nodeName: w.nodeName, // Also set nodeName for compatibility
        message: w.message,
        details: w.details
      }));
    }
    
    if (validationResult.suggestions.length > 0) {
      response.suggestions = validationResult.suggestions;
    }

    // Track successfully validated workflows in telemetry
    if (validationResult.valid) {
      telemetry.trackWorkflowCreation(workflow, true);
    }

    return {
      success: true,
      data: response
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleAutofixWorkflow(
  args: unknown,
  repository: NodeRepository,
  context?: InstanceContext
): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const input = autofixWorkflowSchema.parse(args);

    // First, fetch the workflow from n8n
    const workflowResponse = await handleGetWorkflow({ id: input.id }, context);

    if (!workflowResponse.success) {
      return workflowResponse; // Return the error from fetching
    }

    const workflow = workflowResponse.data as Workflow;

    // Create validator instance using the provided repository
    const validator = new WorkflowValidator(repository, EnhancedConfigValidator);

    // Run validation to identify issues
    const validationResult = await validator.validateWorkflow(workflow, {
      validateNodes: true,
      validateConnections: true,
      validateExpressions: true,
      profile: 'ai-friendly'
    });

    // Check for expression format issues
    const allFormatIssues: any[] = [];
    for (const node of workflow.nodes) {
      const formatContext = {
        nodeType: node.type,
        nodeName: node.name,
        nodeId: node.id
      };

      const nodeFormatIssues = ExpressionFormatValidator.validateNodeParameters(
        node.parameters,
        formatContext
      );

      // Add node information to each format issue
      const enrichedIssues = nodeFormatIssues.map(issue => ({
        ...issue,
        nodeName: node.name,
        nodeId: node.id
      }));

      allFormatIssues.push(...enrichedIssues);
    }

    // Generate fixes using WorkflowAutoFixer
    const autoFixer = new WorkflowAutoFixer(repository);
    const fixResult = autoFixer.generateFixes(
      workflow,
      validationResult,
      allFormatIssues,
      {
        applyFixes: input.applyFixes,
        fixTypes: input.fixTypes,
        confidenceThreshold: input.confidenceThreshold,
        maxFixes: input.maxFixes
      }
    );

    // If no fixes available
    if (fixResult.fixes.length === 0) {
      return {
        success: true,
        data: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          message: 'No automatic fixes available for this workflow',
          validationSummary: {
            errors: validationResult.errors.length,
            warnings: validationResult.warnings.length
          }
        }
      };
    }

    // If preview mode (applyFixes = false)
    if (!input.applyFixes) {
      return {
        success: true,
        data: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          preview: true,
          fixesAvailable: fixResult.fixes.length,
          fixes: fixResult.fixes,
          summary: fixResult.summary,
          stats: fixResult.stats,
          message: `${fixResult.fixes.length} fixes available. Set applyFixes=true to apply them.`
        }
      };
    }

    // Apply fixes using the diff engine
    if (fixResult.operations.length > 0) {
      const updateResult = await handleUpdatePartialWorkflow(
        {
          id: workflow.id,
          operations: fixResult.operations
        },
        context
      );

      if (!updateResult.success) {
        return {
          success: false,
          error: 'Failed to apply fixes',
          details: {
            fixes: fixResult.fixes,
            updateError: updateResult.error
          }
        };
      }

      return {
        success: true,
        data: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          fixesApplied: fixResult.fixes.length,
          fixes: fixResult.fixes,
          summary: fixResult.summary,
          stats: fixResult.stats,
          message: `Successfully applied ${fixResult.fixes.length} fixes to workflow "${workflow.name}"`
        }
      };
    }

    return {
      success: true,
      data: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        message: 'No fixes needed'
      }
    };

  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }

    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// Execution Management Handlers

export async function handleTriggerWebhookWorkflow(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const input = triggerWebhookSchema.parse(args);

    const webhookRequest: WebhookRequest = {
      webhookUrl: input.webhookUrl,
      httpMethod: input.httpMethod || 'POST',
      data: input.data,
      headers: input.headers,
      waitForResponse: input.waitForResponse ?? true
    };

    const response = await client.triggerWebhook(webhookRequest);

    return {
      success: true,
      data: response,
      message: 'Webhook triggered successfully'
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }

    if (error instanceof N8nApiError) {
      // Try to extract execution context from error response
      const errorData = error.details as any;
      const executionId = errorData?.executionId || errorData?.id || errorData?.execution?.id;
      const workflowId = errorData?.workflowId || errorData?.workflow?.id;

      // If we have execution ID, provide specific guidance with n8n_get_execution
      if (executionId) {
        return {
          success: false,
          error: formatExecutionError(executionId, workflowId),
          code: error.code,
          executionId,
          workflowId: workflowId || undefined
        };
      }

      // No execution ID available - workflow likely didn't start
      // Provide guidance to check recent executions
      if (error.code === 'SERVER_ERROR' || error.statusCode && error.statusCode >= 500) {
        return {
          success: false,
          error: formatNoExecutionError(),
          code: error.code
        };
      }

      // For other errors (auth, validation, etc), use standard message
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: error.details as Record<string, unknown> | undefined
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleGetExecution(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);

    // Parse and validate input with new parameters
    const schema = z.object({
      id: z.string(),
      // New filtering parameters
      mode: z.enum(['preview', 'summary', 'filtered', 'full']).optional(),
      nodeNames: z.array(z.string()).optional(),
      itemsLimit: z.number().optional(),
      includeInputData: z.boolean().optional(),
      // Legacy parameter (backward compatibility)
      includeData: z.boolean().optional()
    });

    const params = schema.parse(args);
    const { id, mode, nodeNames, itemsLimit, includeInputData, includeData } = params;

    /**
     * Map legacy includeData parameter to mode for backward compatibility
     *
     * Legacy behavior:
     * - includeData: undefined -> minimal execution summary (no data)
     * - includeData: false -> minimal execution summary (no data)
     * - includeData: true -> full execution data
     *
     * New behavior mapping:
     * - includeData: undefined -> no mode (minimal)
     * - includeData: false -> no mode (minimal)
     * - includeData: true -> mode: 'summary' (2 items per node, not full)
     *
     * Note: Legacy true behavior returned ALL data, which could exceed token limits.
     * New behavior caps at 2 items for safety. Users can use mode: 'full' for old behavior.
     */
    let effectiveMode = mode;
    if (!effectiveMode && includeData !== undefined) {
      effectiveMode = includeData ? 'summary' : undefined;
    }

    // Determine if we need to fetch full data from API
    // We fetch full data if any mode is specified (including preview) or legacy includeData is true
    // Preview mode needs the data to analyze structure and generate recommendations
    const fetchFullData = effectiveMode !== undefined || includeData === true;

    // Fetch execution from n8n API
    const execution = await client.getExecution(id, fetchFullData);

    // If no filtering options specified, return original execution (backward compatibility)
    if (!effectiveMode && !nodeNames && itemsLimit === undefined) {
      return {
        success: true,
        data: execution
      };
    }

    // Apply filtering using ExecutionProcessor
    const filterOptions: ExecutionFilterOptions = {
      mode: effectiveMode,
      nodeNames,
      itemsLimit,
      includeInputData
    };

    const processedExecution = processExecution(execution, filterOptions);

    return {
      success: true,
      data: processedExecution
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }

    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleListExecutions(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const input = listExecutionsSchema.parse(args || {});
    
    const response = await client.listExecutions({
      limit: input.limit || 100,
      cursor: input.cursor,
      workflowId: input.workflowId,
      projectId: input.projectId,
      status: input.status as ExecutionStatus | undefined,
      includeData: input.includeData || false
    });
    
    return {
      success: true,
      data: {
        executions: response.data,
        returned: response.data.length,
        nextCursor: response.nextCursor,
        hasMore: !!response.nextCursor,
        ...(response.nextCursor ? { 
          _note: "More executions available. Use cursor to get next page." 
        } : {})
      }
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleDeleteExecution(args: unknown, context?: InstanceContext): Promise<McpToolResponse> {
  try {
    const client = ensureApiConfigured(context);
    const { id } = z.object({ id: z.string() }).parse(args);
    
    await client.deleteExecution(id);
    
    return {
      success: true,
      message: `Execution ${id} deleted successfully`
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

// System Tools Handlers

export async function handleHealthCheck(context?: InstanceContext): Promise<McpToolResponse> {
  const startTime = Date.now();

  try {
    const client = ensureApiConfigured(context);
    const health = await client.healthCheck();

    // Get MCP version from package.json
    const packageJson = require('../../package.json');
    const mcpVersion = packageJson.version;
    const supportedN8nVersion = packageJson.dependencies?.n8n?.replace(/[^0-9.]/g, '');

    // Check npm for latest version (async, non-blocking)
    const versionCheck = await checkNpmVersion();

    // Get cache metrics for performance monitoring
    const cacheMetricsData = getInstanceCacheMetrics();

    // Calculate response time
    const responseTime = Date.now() - startTime;

    // Build response data
    const responseData: any = {
      status: health.status,
      instanceId: health.instanceId,
      n8nVersion: health.n8nVersion,
      features: health.features,
      apiUrl: getN8nApiConfig()?.baseUrl,
      mcpVersion,
      supportedN8nVersion,
      versionCheck: {
        current: versionCheck.currentVersion,
        latest: versionCheck.latestVersion,
        upToDate: !versionCheck.isOutdated,
        message: formatVersionMessage(versionCheck),
        ...(versionCheck.updateCommand ? { updateCommand: versionCheck.updateCommand } : {})
      },
      performance: {
        responseTimeMs: responseTime,
        cacheHitRate: cacheMetricsData.size > 0
          ? ((cacheMetricsData.hits / (cacheMetricsData.hits + cacheMetricsData.misses)) * 100).toFixed(2) + '%'
          : 'N/A',
        cachedInstances: cacheMetricsData.size
      }
    };

    // Add next steps guidance based on telemetry insights
    responseData.nextSteps = [
      '• Create workflow: n8n_create_workflow',
      '• List workflows: n8n_list_workflows',
      '• Search nodes: search_nodes',
      '• Browse templates: search_templates'
    ];

    // Add update warning if outdated
    if (versionCheck.isOutdated && versionCheck.latestVersion) {
      responseData.updateWarning = `⚠️  n8n-mcp v${versionCheck.latestVersion} is available (you have v${versionCheck.currentVersion}). Update recommended.`;
    }

    // Track result in telemetry
    telemetry.trackEvent('health_check_completed', {
      success: true,
      responseTimeMs: responseTime,
      upToDate: !versionCheck.isOutdated,
      apiConnected: true
    });

    return {
      success: true,
      data: responseData
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;

    // Track failure in telemetry
    telemetry.trackEvent('health_check_failed', {
      success: false,
      responseTimeMs: responseTime,
      errorType: error instanceof N8nApiError ? error.code : 'unknown'
    });

    if (error instanceof N8nApiError) {
      return {
        success: false,
        error: getUserFriendlyErrorMessage(error),
        code: error.code,
        details: {
          apiUrl: getN8nApiConfig()?.baseUrl,
          hint: 'Check if n8n is running and API is enabled',
          troubleshooting: [
            '1. Verify n8n instance is running',
            '2. Check N8N_API_URL is correct',
            '3. Verify N8N_API_KEY has proper permissions',
            '4. Run n8n_diagnostic for detailed analysis'
          ]
        }
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

export async function handleListAvailableTools(context?: InstanceContext): Promise<McpToolResponse> {
  const tools = [
    {
      category: 'Workflow Management',
      tools: [
        { name: 'n8n_create_workflow', description: 'Create new workflows' },
        { name: 'n8n_get_workflow', description: 'Get workflow by ID' },
        { name: 'n8n_get_workflow_details', description: 'Get detailed workflow info with stats' },
        { name: 'n8n_get_workflow_structure', description: 'Get simplified workflow structure' },
        { name: 'n8n_get_workflow_minimal', description: 'Get minimal workflow info' },
        { name: 'n8n_update_workflow', description: 'Update existing workflows' },
        { name: 'n8n_delete_workflow', description: 'Delete workflows' },
        { name: 'n8n_list_workflows', description: 'List workflows with filters' },
        { name: 'n8n_validate_workflow', description: 'Validate workflow from n8n instance' },
        { name: 'n8n_autofix_workflow', description: 'Automatically fix common workflow errors' }
      ]
    },
    {
      category: 'Execution Management',
      tools: [
        { name: 'n8n_trigger_webhook_workflow', description: 'Trigger workflows via webhook' },
        { name: 'n8n_get_execution', description: 'Get execution details' },
        { name: 'n8n_list_executions', description: 'List executions with filters' },
        { name: 'n8n_delete_execution', description: 'Delete execution records' }
      ]
    },
    {
      category: 'System',
      tools: [
        { name: 'n8n_health_check', description: 'Check API connectivity' },
        { name: 'n8n_list_available_tools', description: 'List all available tools' }
      ]
    }
  ];
  
  const config = getN8nApiConfig();
  const apiConfigured = config !== null;
  
  return {
    success: true,
    data: {
      tools,
      apiConfigured,
      configuration: config ? {
        apiUrl: config.baseUrl,
        timeout: config.timeout,
        maxRetries: config.maxRetries
      } : null,
      limitations: [
        'Cannot activate/deactivate workflows via API',
        'Cannot execute workflows directly (must use webhooks)',
        'Cannot stop running executions',
        'Tags and credentials have limited API support'
      ]
    }
  };
}

// Environment-aware debugging helpers

/**
 * Detect cloud platform from environment variables
 * Returns platform name or null if not in cloud
 */
function detectCloudPlatform(): string | null {
  if (process.env.RAILWAY_ENVIRONMENT) return 'railway';
  if (process.env.RENDER) return 'render';
  if (process.env.FLY_APP_NAME) return 'fly';
  if (process.env.HEROKU_APP_NAME) return 'heroku';
  if (process.env.AWS_EXECUTION_ENV) return 'aws';
  if (process.env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  if (process.env.GOOGLE_CLOUD_PROJECT) return 'gcp';
  if (process.env.AZURE_FUNCTIONS_ENVIRONMENT) return 'azure';
  return null;
}

/**
 * Get mode-specific debugging suggestions
 */
function getModeSpecificDebug(mcpMode: string) {
  if (mcpMode === 'http') {
    const port = process.env.MCP_PORT || process.env.PORT || 3000;
    return {
      mode: 'HTTP Server',
      port,
      authTokenConfigured: !!(process.env.MCP_AUTH_TOKEN || process.env.AUTH_TOKEN),
      corsEnabled: true,
      serverUrl: `http://localhost:${port}`,
      healthCheckUrl: `http://localhost:${port}/health`,
      troubleshooting: [
        `1. Test server health: curl http://localhost:${port}/health`,
        '2. Check browser console for CORS errors',
        '3. Verify MCP_AUTH_TOKEN or AUTH_TOKEN if authentication enabled',
        `4. Ensure port ${port} is not in use: lsof -i :${port} (macOS/Linux) or netstat -ano | findstr :${port} (Windows)`,
        '5. Check firewall settings for port access',
        '6. Review server logs for connection errors'
      ],
      commonIssues: [
        'CORS policy blocking browser requests',
        'Port already in use by another application',
        'Authentication token mismatch',
        'Network firewall blocking connections'
      ]
    };
  } else {
    // stdio mode
    const configLocation = process.platform === 'darwin'
      ? '~/Library/Application Support/Claude/claude_desktop_config.json'
      : process.platform === 'win32'
      ? '%APPDATA%\\Claude\\claude_desktop_config.json'
      : '~/.config/Claude/claude_desktop_config.json';

    return {
      mode: 'Standard I/O (Claude Desktop)',
      configLocation,
      troubleshooting: [
        '1. Verify Claude Desktop config file exists and is valid JSON',
        '2. Check MCP server entry: {"mcpServers": {"n8n": {"command": "npx", "args": ["-y", "n8n-mcp"]}}}',
        '3. Restart Claude Desktop after config changes',
        '4. Check Claude Desktop logs for startup errors',
        '5. Test npx can run: npx -y n8n-mcp --version',
        '6. Verify executable permissions if using local installation'
      ],
      commonIssues: [
        'Invalid JSON in claude_desktop_config.json',
        'Incorrect command or args in MCP server config',
        'Claude Desktop not restarted after config changes',
        'npx unable to download or run package',
        'Missing execute permissions on local binary'
      ]
    };
  }
}

/**
 * Get Docker-specific debugging suggestions
 */
function getDockerDebug(isDocker: boolean) {
  if (!isDocker) return null;

  return {
    containerDetected: true,
    troubleshooting: [
      '1. Verify volume mounts for data/nodes.db',
      '2. Check network connectivity to n8n instance',
      '3. Ensure ports are correctly mapped',
      '4. Review container logs: docker logs <container-name>',
      '5. Verify environment variables passed to container',
      '6. Check IS_DOCKER=true is set correctly'
    ],
    commonIssues: [
      'Volume mount not persisting database',
      'Network isolation preventing n8n API access',
      'Port mapping conflicts',
      'Missing environment variables in container'
    ]
  };
}

/**
 * Get cloud platform-specific suggestions
 */
function getCloudPlatformDebug(cloudPlatform: string | null) {
  if (!cloudPlatform) return null;

  const platformGuides: Record<string, any> = {
    railway: {
      name: 'Railway',
      troubleshooting: [
        '1. Check Railway environment variables are set',
        '2. Verify deployment logs in Railway dashboard',
        '3. Ensure PORT matches Railway assigned port (automatic)',
        '4. Check networking configuration for external access'
      ]
    },
    render: {
      name: 'Render',
      troubleshooting: [
        '1. Verify Render environment variables',
        '2. Check Render logs for startup errors',
        '3. Ensure health check endpoint is responding',
        '4. Verify instance type has sufficient resources'
      ]
    },
    fly: {
      name: 'Fly.io',
      troubleshooting: [
        '1. Check Fly.io logs: flyctl logs',
        '2. Verify fly.toml configuration',
        '3. Ensure volumes are properly mounted',
        '4. Check app status: flyctl status'
      ]
    },
    heroku: {
      name: 'Heroku',
      troubleshooting: [
        '1. Check Heroku logs: heroku logs --tail',
        '2. Verify Procfile configuration',
        '3. Ensure dynos are running: heroku ps',
        '4. Check environment variables: heroku config'
      ]
    },
    kubernetes: {
      name: 'Kubernetes',
      troubleshooting: [
        '1. Check pod logs: kubectl logs <pod-name>',
        '2. Verify service and ingress configuration',
        '3. Check persistent volume claims',
        '4. Verify resource limits and requests'
      ]
    },
    aws: {
      name: 'AWS',
      troubleshooting: [
        '1. Check CloudWatch logs',
        '2. Verify IAM roles and permissions',
        '3. Check security groups and networking',
        '4. Verify environment variables in service config'
      ]
    }
  };

  return platformGuides[cloudPlatform] || {
    name: cloudPlatform.toUpperCase(),
    troubleshooting: [
      '1. Check cloud platform logs',
      '2. Verify environment variables are set',
      '3. Check networking and port configuration',
      '4. Review platform-specific documentation'
    ]
  };
}

// Handler: n8n_diagnostic
export async function handleDiagnostic(request: any, context?: InstanceContext): Promise<McpToolResponse> {
  const startTime = Date.now();
  const verbose = request.params?.arguments?.verbose || false;

  // Detect environment for targeted debugging
  const mcpMode = process.env.MCP_MODE || 'stdio';
  const isDocker = process.env.IS_DOCKER === 'true';
  const cloudPlatform = detectCloudPlatform();

  // Check environment variables
  const envVars = {
    N8N_API_URL: process.env.N8N_API_URL || null,
    N8N_API_KEY: process.env.N8N_API_KEY ? '***configured***' : null,
    NODE_ENV: process.env.NODE_ENV || 'production',
    MCP_MODE: mcpMode,
    isDocker,
    cloudPlatform,
    nodeVersion: process.version,
    platform: process.platform
  };

  // Check API configuration
  const apiConfig = getN8nApiConfig();
  const apiConfigured = apiConfig !== null;
  const apiClient = getN8nApiClient(context);

  // Test API connectivity if configured
  let apiStatus = {
    configured: apiConfigured,
    connected: false,
    error: null as string | null,
    version: null as string | null
  };

  if (apiClient) {
    try {
      const health = await apiClient.healthCheck();
      apiStatus.connected = true;
      apiStatus.version = health.n8nVersion || 'unknown';
    } catch (error) {
      apiStatus.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  // Check which tools are available
  const documentationTools = 22; // Base documentation tools
  const managementTools = apiConfigured ? 16 : 0;
  const totalTools = documentationTools + managementTools;

  // Check npm version
  const versionCheck = await checkNpmVersion();

  // Get performance metrics
  const cacheMetricsData = getInstanceCacheMetrics();
  const responseTime = Date.now() - startTime;

  // Build diagnostic report
  const diagnostic: any = {
    timestamp: new Date().toISOString(),
    environment: envVars,
    apiConfiguration: {
      configured: apiConfigured,
      status: apiStatus,
      config: apiConfig ? {
        baseUrl: apiConfig.baseUrl,
        timeout: apiConfig.timeout,
        maxRetries: apiConfig.maxRetries
      } : null
    },
    versionInfo: {
      current: versionCheck.currentVersion,
      latest: versionCheck.latestVersion,
      upToDate: !versionCheck.isOutdated,
      message: formatVersionMessage(versionCheck),
      ...(versionCheck.updateCommand ? { updateCommand: versionCheck.updateCommand } : {})
    },
    toolsAvailability: {
      documentationTools: {
        count: documentationTools,
        enabled: true,
        description: 'Always available - node info, search, validation, etc.'
      },
      managementTools: {
        count: managementTools,
        enabled: apiConfigured,
        description: apiConfigured ?
          'Management tools are ENABLED - create, update, execute workflows' :
          'Management tools are DISABLED - configure N8N_API_URL and N8N_API_KEY to enable'
      },
      totalAvailable: totalTools
    },
    performance: {
      diagnosticResponseTimeMs: responseTime,
      cacheHitRate: cacheMetricsData.size > 0
        ? ((cacheMetricsData.hits / (cacheMetricsData.hits + cacheMetricsData.misses)) * 100).toFixed(2) + '%'
        : 'N/A',
      cachedInstances: cacheMetricsData.size
    }
  };

  // Enhanced guidance based on telemetry insights
  if (apiConfigured && apiStatus.connected) {
    // API is working - provide next steps
    diagnostic.nextSteps = {
      message: '✓ API connected! Here\'s what you can do:',
      recommended: [
        {
          action: 'n8n_list_workflows',
          description: 'See your existing workflows',
          timing: 'Fast (6 seconds median)'
        },
        {
          action: 'n8n_create_workflow',
          description: 'Create a new workflow',
          timing: 'Typically 6-14 minutes to build'
        },
        {
          action: 'search_nodes',
          description: 'Discover available nodes',
          timing: 'Fast - explore 500+ nodes'
        },
        {
          action: 'search_templates',
          description: 'Browse pre-built workflows',
          timing: 'Find examples quickly'
        }
      ],
      tips: [
        '82% of users start creating workflows after diagnostics - you\'re ready to go!',
        'Most common first action: n8n_update_partial_workflow (managing existing workflows)',
        'Use n8n_validate_workflow before deploying to catch issues early'
      ]
    };
  } else if (apiConfigured && !apiStatus.connected) {
    // API configured but not connecting - troubleshooting
    diagnostic.troubleshooting = {
      issue: '⚠️ API configured but connection failed',
      error: apiStatus.error,
      steps: [
        '1. Verify n8n instance is running and accessible',
        '2. Check N8N_API_URL is correct (currently: ' + apiConfig?.baseUrl + ')',
        '3. Test URL in browser: ' + apiConfig?.baseUrl + '/healthz',
        '4. Verify N8N_API_KEY has proper permissions',
        '5. Check firewall/network settings if using remote n8n',
        '6. Try running n8n_health_check again after fixes'
      ],
      commonIssues: [
        'Wrong port number in N8N_API_URL',
        'API key doesn\'t have sufficient permissions',
        'n8n instance not running or crashed',
        'Network firewall blocking connection'
      ],
      documentation: 'https://github.com/czlonkowski/n8n-mcp?tab=readme-ov-file#n8n-management-tools-optional---requires-api-configuration'
    };
  } else {
    // API not configured - setup guidance
    diagnostic.setupGuide = {
      message: 'n8n API not configured. You can still use documentation tools!',
      whatYouCanDoNow: {
        documentation: [
          {
            tool: 'search_nodes',
            description: 'Search 500+ n8n nodes',
            example: 'search_nodes({query: "slack"})'
          },
          {
            tool: 'get_node_essentials',
            description: 'Get node configuration details',
            example: 'get_node_essentials({nodeType: "nodes-base.httpRequest"})'
          },
          {
            tool: 'search_templates',
            description: 'Browse workflow templates',
            example: 'search_templates({query: "chatbot"})'
          },
          {
            tool: 'validate_workflow',
            description: 'Validate workflow JSON',
            example: 'validate_workflow({workflow: {...}})'
          }
        ],
        note: '22 documentation tools available without API configuration'
      },
      whatYouCannotDo: [
        '✗ Create/update workflows in n8n instance',
        '✗ List your workflows',
        '✗ Execute workflows',
        '✗ View execution results'
      ],
      howToEnable: {
        steps: [
          '1. Get your n8n API key: [Your n8n instance]/settings/api',
          '2. Set environment variables:',
          '   N8N_API_URL=https://your-n8n-instance.com',
          '   N8N_API_KEY=your_api_key_here',
          '3. Restart the MCP server',
          '4. Run n8n_diagnostic again to verify',
          '5. All 38 tools will be available!'
        ],
        documentation: 'https://github.com/czlonkowski/n8n-mcp?tab=readme-ov-file#n8n-management-tools-optional---requires-api-configuration'
      }
    };
  }

  // Add version warning if outdated
  if (versionCheck.isOutdated && versionCheck.latestVersion) {
    diagnostic.updateWarning = {
      message: `⚠️ Update available: v${versionCheck.currentVersion} → v${versionCheck.latestVersion}`,
      command: versionCheck.updateCommand,
      benefits: [
        'Latest bug fixes and improvements',
        'New features and tools',
        'Better performance and reliability'
      ]
    };
  }

  // Add environment-aware debugging guidance
  diagnostic.modeSpecificDebug = getModeSpecificDebug(mcpMode);

  // Add Docker-specific debugging if in container
  if (isDocker) {
    diagnostic.dockerDebug = getDockerDebug(true);
  }

  // Add cloud platform-specific debugging if detected
  if (cloudPlatform) {
    diagnostic.cloudPlatformDebug = getCloudPlatformDebug(cloudPlatform);
  }

  // Add verbose debug info if requested
  if (verbose) {
    diagnostic.debug = {
      processEnv: Object.keys(process.env).filter(key =>
        key.startsWith('N8N_') || key.startsWith('MCP_')
      ),
      nodeVersion: process.version,
      platform: process.platform,
      workingDirectory: process.cwd(),
      cacheMetrics: cacheMetricsData
    };
  }

  // Track diagnostic usage with result data
  telemetry.trackEvent('diagnostic_completed', {
    success: true,
    apiConfigured,
    apiConnected: apiStatus.connected,
    toolsAvailable: totalTools,
    responseTimeMs: responseTime,
    upToDate: !versionCheck.isOutdated,
    verbose
  });

  return {
    success: true,
    data: diagnostic
  };
}
