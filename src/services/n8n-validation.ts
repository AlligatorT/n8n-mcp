import { z } from 'zod';
import { WorkflowNode, WorkflowConnection, Workflow } from '../types/n8n-api';
import { isTriggerNode, isActivatableTrigger } from '../utils/node-type-utils';
import { isNonExecutableNode } from '../utils/node-classification';

// Zod schemas for n8n API validation

export const workflowNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  typeVersion: z.number(),
  position: z.tuple([z.number(), z.number()]),
  parameters: z.record(z.unknown()),
  credentials: z.record(z.unknown()).optional(),
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
  notesInFlow: z.boolean().optional(),
  continueOnFail: z.boolean().optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().optional(),
  waitBetweenTries: z.number().optional(),
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
});

// Connection array schema used by all connection types
const connectionArraySchema = z.array(
  z.array(
    z.object({
      node: z.string(),
      type: z.string(),
      index: z.number(),
    })
  )
);

/**
 * Workflow connection schema supporting all connection types.
 * Note: 'main' is optional because AI nodes exclusively use AI-specific
 * connection types (ai_languageModel, ai_memory, etc.) without main connections.
 */
export const workflowConnectionSchema = z.record(
  z.object({
    main: connectionArraySchema.optional(),
    error: connectionArraySchema.optional(),
    ai_tool: connectionArraySchema.optional(),
    ai_languageModel: connectionArraySchema.optional(),
    ai_memory: connectionArraySchema.optional(),
    ai_embedding: connectionArraySchema.optional(),
    ai_vectorStore: connectionArraySchema.optional(),
  })
);

export const workflowSettingsSchema = z.object({
  executionOrder: z.enum(['v0', 'v1']).default('v1'),
  timezone: z.string().optional(),
  saveDataErrorExecution: z.enum(['all', 'none']).default('all'),
  saveDataSuccessExecution: z.enum(['all', 'none']).default('all'),
  saveManualExecutions: z.boolean().default(true),
  saveExecutionProgress: z.boolean().default(true),
  executionTimeout: z.number().optional(),
  errorWorkflow: z.string().optional(),
  callerPolicy: z.enum(['any', 'workflowsFromSameOwner', 'workflowsFromAList']).optional(),
});

// Default settings for workflow creation
export const defaultWorkflowSettings = {
  executionOrder: 'v1' as const,
  saveDataErrorExecution: 'all' as const,
  saveDataSuccessExecution: 'all' as const,
  saveManualExecutions: true,
  saveExecutionProgress: true,
};

// Validation functions
export function validateWorkflowNode(node: unknown): WorkflowNode {
  return workflowNodeSchema.parse(node);
}

export function validateWorkflowConnections(connections: unknown): WorkflowConnection {
  return workflowConnectionSchema.parse(connections);
}

export function validateWorkflowSettings(settings: unknown): z.infer<typeof workflowSettingsSchema> {
  return workflowSettingsSchema.parse(settings);
}

// Clean workflow data for API operations
export function cleanWorkflowForCreate(workflow: Partial<Workflow>): Partial<Workflow> {
  const {
    // Remove read-only fields
    id,
    createdAt,
    updatedAt,
    versionId,
    meta,
    // Remove fields that cause API errors during creation
    active,
    tags,
    // Keep everything else
    ...cleanedWorkflow
  } = workflow;

  // Ensure settings are present with defaults
  if (!cleanedWorkflow.settings) {
    cleanedWorkflow.settings = defaultWorkflowSettings;
  }

  return cleanedWorkflow;
}

/**
 * Clean workflow data for update operations.
 *
 * This function removes read-only and computed fields that should not be sent
 * in API update requests. It does NOT add any default values or new fields.
 *
 * Note: Unlike cleanWorkflowForCreate, this function does not add default settings.
 * The n8n API will reject update requests that include properties not present in
 * the original workflow ("settings must NOT have additional properties" error).
 *
 * Settings are filtered to only include whitelisted properties to prevent API
 * errors when workflows from n8n contain UI-only or deprecated properties.
 *
 * @param workflow - The workflow object to clean
 * @returns A cleaned partial workflow suitable for API updates
 */
export function cleanWorkflowForUpdate(workflow: Workflow): Partial<Workflow> {
  const {
    // Remove read-only/computed fields
    id,
    createdAt,
    updatedAt,
    versionId,
    meta,
    staticData,
    // Remove fields that cause API errors
    pinData,
    tags,
    // Remove additional fields that n8n API doesn't accept
    isArchived,
    usedCredentials,
    sharedWithProjects,
    triggerCount,
    shared,
    active,
    // Keep everything else
    ...cleanedWorkflow
  } = workflow as any;

  // CRITICAL FIX for Issue #248:
  // The n8n API has version-specific behavior for settings in workflow updates:
  //
  // PROBLEM:
  // - Some versions reject updates with settings properties (community forum reports)
  // - Cloud versions REQUIRE settings property to be present (n8n.estyl.team)
  // - Properties like callerPolicy cause "additional properties" errors
  //
  // SOLUTION:
  // - Filter settings to only include whitelisted properties (OpenAPI spec)
  // - If no settings provided, use empty object {} for safety
  // - Empty object satisfies "required property" validation (cloud API)
  // - Whitelisted properties prevent "additional properties" errors
  //
  // References:
  // - https://community.n8n.io/t/api-workflow-update-endpoint-doesnt-support-setting-callerpolicy/161916
  // - OpenAPI spec: workflowSettings schema
  // - Tested on n8n.estyl.team (cloud) and localhost (self-hosted)

  // Whitelisted settings properties from n8n OpenAPI spec
  const safeSettingsProperties = [
    'saveExecutionProgress',
    'saveManualExecutions',
    'saveDataErrorExecution',
    'saveDataSuccessExecution',
    'executionTimeout',
    'errorWorkflow',
    'timezone',
    'executionOrder'
  ];

  if (cleanedWorkflow.settings && typeof cleanedWorkflow.settings === 'object') {
    // Filter to only safe properties
    const filteredSettings: any = {};
    for (const key of safeSettingsProperties) {
      if (key in cleanedWorkflow.settings) {
        filteredSettings[key] = (cleanedWorkflow.settings as any)[key];
      }
    }
    cleanedWorkflow.settings = filteredSettings;
  } else {
    // No settings provided - use empty object for safety
    cleanedWorkflow.settings = {};
  }

  return cleanedWorkflow;
}

// Validate workflow structure
export function validateWorkflowStructure(workflow: Partial<Workflow>): string[] {
  const errors: string[] = [];

  // Check required fields
  if (!workflow.name) {
    errors.push('Workflow name is required');
  }

  if (!workflow.nodes || workflow.nodes.length === 0) {
    errors.push('Workflow must have at least one node');
  }

  // Check if workflow has only non-executable nodes (sticky notes)
  if (workflow.nodes && workflow.nodes.length > 0) {
    const hasExecutableNodes = workflow.nodes.some(node => !isNonExecutableNode(node.type));
    if (!hasExecutableNodes) {
      errors.push('Workflow must have at least one executable node. Sticky notes alone cannot form a valid workflow.');
    }
  }

  if (!workflow.connections) {
    errors.push('Workflow connections are required');
  }

  // Check for minimum viable workflow
  if (workflow.nodes && workflow.nodes.length === 1) {
    const singleNode = workflow.nodes[0];
    const isWebhookOnly = singleNode.type === 'n8n-nodes-base.webhook' ||
                         singleNode.type === 'n8n-nodes-base.webhookTrigger';

    if (!isWebhookOnly) {
      errors.push(`Single non-webhook node workflow is invalid. Current node: "${singleNode.name}" (${singleNode.type}). Add another node using: {type: 'addNode', node: {name: 'Process Data', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [450, 300], parameters: {}}}`);
    }
  }

  // Check for disconnected nodes in multi-node workflows
  if (workflow.nodes && workflow.nodes.length > 1 && workflow.connections) {
    // Filter out non-executable nodes (sticky notes) when counting nodes
    const executableNodes = workflow.nodes.filter(node => !isNonExecutableNode(node.type));
    const connectionCount = Object.keys(workflow.connections).length;

    // First check: workflow has no connections at all (only check if there are multiple executable nodes)
    if (connectionCount === 0 && executableNodes.length > 1) {
      const nodeNames = executableNodes.slice(0, 2).map(n => n.name);
      errors.push(`Multi-node workflow has no connections between nodes. Add a connection using: {type: 'addConnection', source: '${nodeNames[0]}', target: '${nodeNames[1]}', sourcePort: 'main', targetPort: 'main'}`);
    } else if (connectionCount > 0 || executableNodes.length > 1) {
      // Second check: detect disconnected nodes (nodes with no incoming or outgoing connections)
      const connectedNodes = new Set<string>();

      // Collect all nodes that appear in connections (as source or target)
      Object.entries(workflow.connections).forEach(([sourceName, connection]) => {
        connectedNodes.add(sourceName); // Node has outgoing connection

        if (connection.main && Array.isArray(connection.main)) {
          connection.main.forEach((outputs) => {
            if (Array.isArray(outputs)) {
              outputs.forEach((target) => {
                connectedNodes.add(target.node); // Node has incoming connection
              });
            }
          });
        }
      });

      // Find disconnected nodes (excluding non-executable nodes and triggers)
      // Non-executable nodes (sticky notes) are UI-only and don't need connections
      // Trigger nodes only need outgoing connections
      const disconnectedNodes = workflow.nodes.filter(node => {
        // Skip non-executable nodes (sticky notes, etc.) - they're UI-only annotations
        if (isNonExecutableNode(node.type)) {
          return false;
        }

        const isConnected = connectedNodes.has(node.name);
        const isNodeTrigger = isTriggerNode(node.type);

        // Trigger nodes only need outgoing connections
        if (isNodeTrigger) {
          return !workflow.connections?.[node.name]; // Disconnected if no outgoing connections
        }

        // Regular nodes need at least one connection (incoming or outgoing)
        return !isConnected;
      });

      if (disconnectedNodes.length > 0) {
        const disconnectedList = disconnectedNodes.map(n => `"${n.name}" (${n.type})`).join(', ');
        const firstDisconnected = disconnectedNodes[0];
        const suggestedSource = workflow.nodes.find(n => connectedNodes.has(n.name))?.name || workflow.nodes[0].name;

        errors.push(`Disconnected nodes detected: ${disconnectedList}. Each node must have at least one connection. Add a connection: {type: 'addConnection', source: '${suggestedSource}', target: '${firstDisconnected.name}', sourcePort: 'main', targetPort: 'main'}`);
      }
    }
  }

  // Validate nodes
  if (workflow.nodes) {
    workflow.nodes.forEach((node, index) => {
      try {
        validateWorkflowNode(node);
        
        // Additional check for common node type mistakes
        if (node.type.startsWith('nodes-base.')) {
          errors.push(`Invalid node type "${node.type}" at index ${index}. Use "n8n-nodes-base.${node.type.substring(11)}" instead.`);
        } else if (!node.type.includes('.')) {
          errors.push(`Invalid node type "${node.type}" at index ${index}. Node types must include package prefix (e.g., "n8n-nodes-base.webhook").`);
        }
      } catch (error) {
        errors.push(`Invalid node at index ${index}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });
  }

  // Validate filter-based nodes (IF v2.2+, Switch v3.2+) have complete metadata
  if (workflow.nodes) {
    workflow.nodes.forEach((node, index) => {
      const filterErrors = validateFilterBasedNodeMetadata(node);
      if (filterErrors.length > 0) {
        errors.push(...filterErrors.map(err => `Node "${node.name}" (index ${index}): ${err}`));
      }
    });
  }

  // Validate connections
  if (workflow.connections) {
    try {
      validateWorkflowConnections(workflow.connections);
    } catch (error) {
      errors.push(`Invalid connections: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Validate active workflows have activatable triggers
  // Issue #351: executeWorkflowTrigger cannot activate a workflow
  // It can only be invoked by other workflows
  if ((workflow as any).active === true && workflow.nodes && workflow.nodes.length > 0) {
    const activatableTriggers = workflow.nodes.filter(node =>
      !node.disabled && isActivatableTrigger(node.type)
    );

    const executeWorkflowTriggers = workflow.nodes.filter(node =>
      !node.disabled && node.type.toLowerCase().includes('executeworkflow')
    );

    if (activatableTriggers.length === 0 && executeWorkflowTriggers.length > 0) {
      // Workflow is active but only has executeWorkflowTrigger nodes
      const triggerNames = executeWorkflowTriggers.map(n => n.name).join(', ');
      errors.push(
        `Cannot activate workflow with only Execute Workflow Trigger nodes (${triggerNames}). ` +
        'Execute Workflow Trigger can only be invoked by other workflows, not activated. ' +
        'Either deactivate the workflow or add a webhook/schedule/polling trigger.'
      );
    }
  }

  // Validate Switch and IF node connection structures match their rules
  if (workflow.nodes && workflow.connections) {
    const switchNodes = workflow.nodes.filter(n => {
      if (n.type !== 'n8n-nodes-base.switch') return false;
      const mode = (n.parameters as any)?.mode;
      return !mode || mode === 'rules'; // Default mode is 'rules'
    });

    for (const switchNode of switchNodes) {
      const params = switchNode.parameters as any;
      const rules = params?.rules?.rules || [];
      const nodeConnections = workflow.connections[switchNode.name];

      if (rules.length > 0 && nodeConnections?.main) {
        const outputBranches = nodeConnections.main.length;

        // Switch nodes in "rules" mode need output branches matching rules count
        if (outputBranches !== rules.length) {
          const ruleNames = rules.map((r: any, i: number) =>
            r.outputKey ? `"${r.outputKey}" (index ${i})` : `Rule ${i}`
          ).join(', ');

          errors.push(
            `Switch node "${switchNode.name}" has ${rules.length} rules [${ruleNames}] ` +
            `but only ${outputBranches} output branch${outputBranches !== 1 ? 'es' : ''} in connections. ` +
            `Each rule needs its own output branch. When connecting to Switch outputs, specify sourceIndex: ` +
            rules.map((_: any, i: number) => i).join(', ') +
            ` (or use case parameter for clarity).`
          );
        }

        // Check for empty output branches (except trailing ones)
        const nonEmptyBranches = nodeConnections.main.filter((branch: any[]) => branch.length > 0).length;
        if (nonEmptyBranches < rules.length) {
          const emptyIndices = nodeConnections.main
            .map((branch: any[], i: number) => branch.length === 0 ? i : -1)
            .filter((i: number) => i !== -1 && i < rules.length);

          if (emptyIndices.length > 0) {
            const ruleInfo = emptyIndices.map((i: number) => {
              const rule = rules[i];
              return rule.outputKey ? `"${rule.outputKey}" (index ${i})` : `Rule ${i}`;
            }).join(', ');

            errors.push(
              `Switch node "${switchNode.name}" has unconnected output${emptyIndices.length !== 1 ? 's' : ''}: ${ruleInfo}. ` +
              `Add connection${emptyIndices.length !== 1 ? 's' : ''} using sourceIndex: ${emptyIndices.join(' or ')}.`
            );
          }
        }
      }
    }
  }

  // Validate that all connection references exist and use node NAMES (not IDs)
  if (workflow.nodes && workflow.connections) {
    const nodeNames = new Set(workflow.nodes.map(node => node.name));
    const nodeIds = new Set(workflow.nodes.map(node => node.id));
    const nodeIdToName = new Map(workflow.nodes.map(node => [node.id, node.name]));

    Object.entries(workflow.connections).forEach(([sourceName, connection]) => {
      // Check if source exists by name (correct)
      if (!nodeNames.has(sourceName)) {
        // Check if they're using an ID instead of name
        if (nodeIds.has(sourceName)) {
          const correctName = nodeIdToName.get(sourceName);
          errors.push(`Connection uses node ID '${sourceName}' but must use node name '${correctName}'. Change connections.${sourceName} to connections['${correctName}']`);
        } else {
          errors.push(`Connection references non-existent node: ${sourceName}`);
        }
      }
      
      if (connection.main && Array.isArray(connection.main)) {
        connection.main.forEach((outputs, outputIndex) => {
          if (Array.isArray(outputs)) {
            outputs.forEach((target, targetIndex) => {
              // Check if target exists by name (correct)
              if (!nodeNames.has(target.node)) {
                // Check if they're using an ID instead of name
                if (nodeIds.has(target.node)) {
                  const correctName = nodeIdToName.get(target.node);
                  errors.push(`Connection target uses node ID '${target.node}' but must use node name '${correctName}' (from ${sourceName}[${outputIndex}][${targetIndex}])`);
                } else {
                  errors.push(`Connection references non-existent target node: ${target.node} (from ${sourceName}[${outputIndex}][${targetIndex}])`);
                }
              }
            });
          }
        });
      }
    });
  }

  return errors;
}

// Check if workflow has webhook trigger
export function hasWebhookTrigger(workflow: Workflow): boolean {
  return workflow.nodes.some(node =>
    node.type === 'n8n-nodes-base.webhook' ||
    node.type === 'n8n-nodes-base.webhookTrigger'
  );
}

/**
 * Validate filter-based node metadata (IF v2.2+, Switch v3.2+)
 * Returns array of error messages
 */
export function validateFilterBasedNodeMetadata(node: WorkflowNode): string[] {
  const errors: string[] = [];

  // Check if node is filter-based
  const isIFNode = node.type === 'n8n-nodes-base.if' && node.typeVersion >= 2.2;
  const isSwitchNode = node.type === 'n8n-nodes-base.switch' && node.typeVersion >= 3.2;

  if (!isIFNode && !isSwitchNode) {
    return errors; // Not a filter-based node
  }

  // Validate IF node
  if (isIFNode) {
    const conditions = (node.parameters.conditions as any);

    // Check conditions.options exists
    if (!conditions?.options) {
      errors.push(
        'Missing required "conditions.options". ' +
        'IF v2.2+ requires: {version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict"}'
      );
    } else {
      // Validate required fields
      const requiredFields = {
        version: 2,
        leftValue: '',
        caseSensitive: 'boolean',
        typeValidation: 'strict'
      };

      for (const [field, expectedValue] of Object.entries(requiredFields)) {
        if (!(field in conditions.options)) {
          errors.push(
            `Missing required field "conditions.options.${field}". ` +
            `Expected value: ${typeof expectedValue === 'string' ? `"${expectedValue}"` : expectedValue}`
          );
        }
      }
    }

    // Validate operators in conditions
    if (conditions?.conditions && Array.isArray(conditions.conditions)) {
      conditions.conditions.forEach((condition: any, i: number) => {
        const operatorErrors = validateOperatorStructure(condition.operator, `conditions.conditions[${i}].operator`);
        errors.push(...operatorErrors);
      });
    }
  }

  // Validate Switch node
  if (isSwitchNode) {
    const rules = (node.parameters.rules as any);

    if (rules?.rules && Array.isArray(rules.rules)) {
      rules.rules.forEach((rule: any, ruleIndex: number) => {
        // Check rule.conditions.options
        if (!rule.conditions?.options) {
          errors.push(
            `Missing required "rules.rules[${ruleIndex}].conditions.options". ` +
            'Switch v3.2+ requires: {version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict"}'
          );
        } else {
          // Validate required fields
          const requiredFields = {
            version: 2,
            leftValue: '',
            caseSensitive: 'boolean',
            typeValidation: 'strict'
          };

          for (const [field, expectedValue] of Object.entries(requiredFields)) {
            if (!(field in rule.conditions.options)) {
              errors.push(
                `Missing required field "rules.rules[${ruleIndex}].conditions.options.${field}". ` +
                `Expected value: ${typeof expectedValue === 'string' ? `"${expectedValue}"` : expectedValue}`
              );
            }
          }
        }

        // Validate operators in rule conditions
        if (rule.conditions?.conditions && Array.isArray(rule.conditions.conditions)) {
          rule.conditions.conditions.forEach((condition: any, condIndex: number) => {
            const operatorErrors = validateOperatorStructure(
              condition.operator,
              `rules.rules[${ruleIndex}].conditions.conditions[${condIndex}].operator`
            );
            errors.push(...operatorErrors);
          });
        }
      });
    }
  }

  return errors;
}

/**
 * Validate operator structure
 * Ensures operator has correct format: {type, operation, singleValue?}
 */
export function validateOperatorStructure(operator: any, path: string): string[] {
  const errors: string[] = [];

  if (!operator || typeof operator !== 'object') {
    errors.push(`${path}: operator is missing or not an object`);
    return errors;
  }

  // Check required field: type (data type, not operation name)
  if (!operator.type) {
    errors.push(
      `${path}: missing required field "type". ` +
      'Must be a data type: "string", "number", "boolean", "dateTime", "array", or "object"'
    );
  } else {
    const validTypes = ['string', 'number', 'boolean', 'dateTime', 'array', 'object'];
    if (!validTypes.includes(operator.type)) {
      errors.push(
        `${path}: invalid type "${operator.type}". ` +
        `Type must be a data type (${validTypes.join(', ')}), not an operation name. ` +
        'Did you mean to use the "operation" field?'
      );
    }
  }

  // Check required field: operation
  if (!operator.operation) {
    errors.push(
      `${path}: missing required field "operation". ` +
      'Operation specifies the comparison type (e.g., "equals", "contains", "isNotEmpty")'
    );
  }

  // Check singleValue based on operator type
  if (operator.operation) {
    const unaryOperators = ['isEmpty', 'isNotEmpty', 'true', 'false', 'isNumeric'];
    const isUnary = unaryOperators.includes(operator.operation);

    if (isUnary) {
      // Unary operators MUST have singleValue: true
      if (operator.singleValue !== true) {
        errors.push(
          `${path}: unary operator "${operator.operation}" requires "singleValue: true". ` +
          'Unary operators do not use rightValue.'
        );
      }
    } else {
      // Binary operators should NOT have singleValue: true
      if (operator.singleValue === true) {
        errors.push(
          `${path}: binary operator "${operator.operation}" should not have "singleValue: true". ` +
          'Only unary operators (isEmpty, isNotEmpty, true, false, isNumeric) need this property.'
        );
      }
    }
  }

  return errors;
}

// Get webhook URL from workflow
export function getWebhookUrl(workflow: Workflow): string | null {
  const webhookNode = workflow.nodes.find(node => 
    node.type === 'n8n-nodes-base.webhook' || 
    node.type === 'n8n-nodes-base.webhookTrigger'
  );

  if (!webhookNode || !webhookNode.parameters) {
    return null;
  }

  // Check for path parameter
  const path = webhookNode.parameters.path as string | undefined;
  if (!path) {
    return null;
  }

  // Note: We can't construct the full URL without knowing the n8n instance URL
  // The caller will need to prepend the base URL
  return path;
}

// Helper function to generate proper workflow structure examples
export function getWorkflowStructureExample(): string {
  return `
Minimal Workflow Example:
{
  "name": "My Workflow",
  "nodes": [
    {
      "id": "manual-trigger-1",
      "name": "Manual Trigger",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [250, 300],
      "parameters": {}
    },
    {
      "id": "set-1",
      "name": "Set Data",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [450, 300],
      "parameters": {
        "mode": "manual",
        "assignments": {
          "assignments": [{
            "id": "1",
            "name": "message",
            "value": "Hello World",
            "type": "string"
          }]
        }
      }
    }
  ],
  "connections": {
    "Manual Trigger": {
      "main": [[{
        "node": "Set Data",
        "type": "main",
        "index": 0
      }]]
    }
  }
}

IMPORTANT: In connections, use the node NAME (e.g., "Manual Trigger"), NOT the node ID or type!`;
}

// Helper function to fix common workflow issues
export function getWorkflowFixSuggestions(errors: string[]): string[] {
  const suggestions: string[] = [];
  
  if (errors.some(e => e.includes('empty connections'))) {
    suggestions.push('Add connections between your nodes. Each node (except endpoints) should connect to another node.');
    suggestions.push('Connection format: connections: { "Source Node Name": { "main": [[{ "node": "Target Node Name", "type": "main", "index": 0 }]] } }');
  }
  
  if (errors.some(e => e.includes('Single-node workflows'))) {
    suggestions.push('Add at least one more node to process data. Common patterns: Trigger → Process → Output');
    suggestions.push('Examples: Manual Trigger → Set, Webhook → HTTP Request, Schedule Trigger → Database Query');
  }
  
  if (errors.some(e => e.includes('node ID') && e.includes('instead of node name'))) {
    suggestions.push('Replace node IDs with node names in connections. The name is what appears in the node header.');
    suggestions.push('Wrong: connections: { "set-1": {...} }, Right: connections: { "Set Data": {...} }');
  }
  
  return suggestions;
}