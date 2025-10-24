/**
 * MCP Handler for Partial Workflow Updates
 * Handles diff-based workflow modifications
 */

import { z } from 'zod';
import { McpToolResponse } from '../types/n8n-api';
import { WorkflowDiffRequest, WorkflowDiffOperation } from '../types/workflow-diff';
import { WorkflowDiffEngine } from '../services/workflow-diff-engine';
import { getN8nApiClient } from './handlers-n8n-manager';
import { N8nApiError, getUserFriendlyErrorMessage } from '../utils/n8n-errors';
import { logger } from '../utils/logger';
import { InstanceContext } from '../types/instance-context';
import { validateWorkflowStructure } from '../services/n8n-validation';
import { NodeRepository } from '../database/node-repository';
import { WorkflowVersioningService } from '../services/workflow-versioning-service';

// Zod schema for the diff request
const workflowDiffSchema = z.object({
  id: z.string(),
  operations: z.array(z.object({
    type: z.string(),
    description: z.string().optional(),
    // Node operations
    node: z.any().optional(),
    nodeId: z.string().optional(),
    nodeName: z.string().optional(),
    updates: z.any().optional(),
    position: z.tuple([z.number(), z.number()]).optional(),
    // Connection operations
    source: z.string().optional(),
    target: z.string().optional(),
    from: z.string().optional(),  // For rewireConnection
    to: z.string().optional(),    // For rewireConnection
    sourceOutput: z.string().optional(),
    targetInput: z.string().optional(),
    sourceIndex: z.number().optional(),
    targetIndex: z.number().optional(),
    // Smart parameters (Phase 1 UX improvement)
    branch: z.enum(['true', 'false']).optional(),
    case: z.number().optional(),
    ignoreErrors: z.boolean().optional(),
    // Connection cleanup operations
    dryRun: z.boolean().optional(),
    connections: z.any().optional(),
    // Metadata operations
    settings: z.any().optional(),
    name: z.string().optional(),
    tag: z.string().optional(),
  })),
  validateOnly: z.boolean().optional(),
  continueOnError: z.boolean().optional(),
  createBackup: z.boolean().optional(),
});

export async function handleUpdatePartialWorkflow(
  args: unknown,
  repository: NodeRepository,
  context?: InstanceContext
): Promise<McpToolResponse> {
  try {
    // Debug logging (only in debug mode)
    if (process.env.DEBUG_MCP === 'true') {
      logger.debug('Workflow diff request received', {
        argsType: typeof args,
        hasWorkflowId: args && typeof args === 'object' && 'workflowId' in args,
        operationCount: args && typeof args === 'object' && 'operations' in args ? 
          (args as any).operations?.length : 0
      });
    }
    
    // Validate input
    const input = workflowDiffSchema.parse(args);
    
    // Get API client
    const client = getN8nApiClient(context);
    if (!client) {
      return {
        success: false,
        error: 'n8n API not configured. Please set N8N_API_URL and N8N_API_KEY environment variables.'
      };
    }
    
    // Fetch current workflow
    let workflow;
    try {
      workflow = await client.getWorkflow(input.id);
    } catch (error) {
      if (error instanceof N8nApiError) {
        return {
          success: false,
          error: getUserFriendlyErrorMessage(error),
          code: error.code
        };
      }
      throw error;
    }

    // Create backup before modifying workflow (default: true)
    if (input.createBackup !== false && !input.validateOnly) {
      try {
        const versioningService = new WorkflowVersioningService(repository, client);
        const backupResult = await versioningService.createBackup(input.id, workflow, {
          trigger: 'partial_update',
          operations: input.operations
        });

        logger.info('Workflow backup created', {
          workflowId: input.id,
          versionId: backupResult.versionId,
          versionNumber: backupResult.versionNumber,
          pruned: backupResult.pruned
        });
      } catch (error: any) {
        logger.warn('Failed to create workflow backup', {
          workflowId: input.id,
          error: error.message
        });
        // Continue with update even if backup fails (non-blocking)
      }
    }

    // Apply diff operations
    const diffEngine = new WorkflowDiffEngine();
    const diffRequest = input as WorkflowDiffRequest;
    const diffResult = await diffEngine.applyDiff(workflow, diffRequest);

    // Check if this is a complete failure or partial success in continueOnError mode
    if (!diffResult.success) {
      // In continueOnError mode, partial success is still valuable
      if (diffRequest.continueOnError && diffResult.workflow && diffResult.operationsApplied && diffResult.operationsApplied > 0) {
        logger.info(`continueOnError mode: Applying ${diffResult.operationsApplied} successful operations despite ${diffResult.failed?.length || 0} failures`);
        // Continue to update workflow with partial changes
      } else {
        // Complete failure - return error
        return {
          success: false,
          error: 'Failed to apply diff operations',
          details: {
            errors: diffResult.errors,
            operationsApplied: diffResult.operationsApplied,
            applied: diffResult.applied,
            failed: diffResult.failed
          }
        };
      }
    }
    
    // If validateOnly, return validation result
    if (input.validateOnly) {
      return {
        success: true,
        message: diffResult.message,
        data: {
          valid: true,
          operationsToApply: input.operations.length
        }
      };
    }

    // Validate final workflow structure after applying all operations
    // This prevents creating workflows that pass operation-level validation
    // but fail workflow-level validation (e.g., UI can't render them)
    //
    // Validation can be skipped for specific integration tests that need to test
    // n8n API behavior with edge case workflows by setting SKIP_WORKFLOW_VALIDATION=true
    if (diffResult.workflow) {
      const structureErrors = validateWorkflowStructure(diffResult.workflow);
      if (structureErrors.length > 0) {
        const skipValidation = process.env.SKIP_WORKFLOW_VALIDATION === 'true';

        logger.warn('Workflow structure validation failed after applying diff operations', {
          workflowId: input.id,
          errors: structureErrors,
          blocking: !skipValidation
        });

        // Analyze error types to provide targeted recovery guidance
        const errorTypes = new Set<string>();
        structureErrors.forEach(err => {
          if (err.includes('operator') || err.includes('singleValue')) errorTypes.add('operator_issues');
          if (err.includes('connection') || err.includes('referenced')) errorTypes.add('connection_issues');
          if (err.includes('Missing') || err.includes('missing')) errorTypes.add('missing_metadata');
          if (err.includes('branch') || err.includes('output')) errorTypes.add('branch_mismatch');
        });

        // Build recovery guidance based on error types
        const recoverySteps = [];
        if (errorTypes.has('operator_issues')) {
          recoverySteps.push('Operator structure issue detected. Use validate_node_operation to check specific nodes.');
          recoverySteps.push('Binary operators (equals, contains, greaterThan, etc.) must NOT have singleValue:true');
          recoverySteps.push('Unary operators (isEmpty, isNotEmpty, true, false) REQUIRE singleValue:true');
        }
        if (errorTypes.has('connection_issues')) {
          recoverySteps.push('Connection validation failed. Check all node connections reference existing nodes.');
          recoverySteps.push('Use cleanStaleConnections operation to remove connections to non-existent nodes.');
        }
        if (errorTypes.has('missing_metadata')) {
          recoverySteps.push('Missing metadata detected. Ensure filter-based nodes (IF v2.2+, Switch v3.2+) have complete conditions.options.');
          recoverySteps.push('Required options: {version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict"}');
        }
        if (errorTypes.has('branch_mismatch')) {
          recoverySteps.push('Branch count mismatch. Ensure Switch nodes have outputs for all rules (e.g., 3 rules = 3 output branches).');
        }

        // Add generic recovery steps if no specific guidance
        if (recoverySteps.length === 0) {
          recoverySteps.push('Review the validation errors listed above');
          recoverySteps.push('Fix issues using updateNode or cleanStaleConnections operations');
          recoverySteps.push('Run validate_workflow again to verify fixes');
        }

        const errorMessage = structureErrors.length === 1
          ? `Workflow validation failed: ${structureErrors[0]}`
          : `Workflow validation failed with ${structureErrors.length} structural issues`;

        // If validation is not skipped, return error and block the save
        if (!skipValidation) {
          return {
            success: false,
            error: errorMessage,
            details: {
              errors: structureErrors,
              errorCount: structureErrors.length,
              operationsApplied: diffResult.operationsApplied,
              applied: diffResult.applied,
              recoveryGuidance: recoverySteps,
              note: 'Operations were applied but created an invalid workflow structure. The workflow was NOT saved to n8n to prevent UI rendering errors.',
              autoSanitizationNote: 'Auto-sanitization runs on all nodes during updates to fix operator structures and add missing metadata. However, it cannot fix all issues (e.g., broken connections, branch mismatches). Use the recovery guidance above to resolve remaining issues.'
            }
          };
        }
        // Validation skipped: log warning but continue (for specific integration tests)
        logger.info('Workflow validation skipped (SKIP_WORKFLOW_VALIDATION=true): Allowing workflow with validation warnings to proceed', {
          workflowId: input.id,
          warningCount: structureErrors.length
        });
      }
    }

    // Update workflow via API
    try {
      const updatedWorkflow = await client.updateWorkflow(input.id, diffResult.workflow!);
      
      return {
        success: true,
        data: updatedWorkflow,
        message: `Workflow "${updatedWorkflow.name}" updated successfully. Applied ${diffResult.operationsApplied} operations.`,
        details: {
          operationsApplied: diffResult.operationsApplied,
          workflowId: updatedWorkflow.id,
          workflowName: updatedWorkflow.name,
          applied: diffResult.applied,
          failed: diffResult.failed,
          errors: diffResult.errors
        }
      };
    } catch (error) {
      if (error instanceof N8nApiError) {
        return {
          success: false,
          error: getUserFriendlyErrorMessage(error),
          code: error.code,
          details: error.details as Record<string, unknown> | undefined
        };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid input',
        details: { errors: error.errors }
      };
    }
    
    logger.error('Failed to update partial workflow', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}

