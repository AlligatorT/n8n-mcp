import { PropertyExtractor } from './property-extractor';
import type {
  NodeClass,
  VersionedNodeInstance
} from '../types/node-types';
import {
  isVersionedNodeInstance,
  isVersionedNodeClass,
  getNodeDescription as getNodeDescriptionHelper
} from '../types/node-types';
import type { INodeTypeBaseDescription, INodeTypeDescription } from 'n8n-workflow';

export interface ParsedNode {
  style: 'declarative' | 'programmatic';
  nodeType: string;
  displayName: string;
  description?: string;
  category?: string;
  properties: any[];
  credentials: any[];
  isAITool: boolean;
  isTrigger: boolean;
  isWebhook: boolean;
  operations: any[];
  version?: string;
  isVersioned: boolean;
  packageName: string;
  documentation?: string;
  outputs?: any[];
  outputNames?: string[];
}

export class NodeParser {
  private propertyExtractor = new PropertyExtractor();
  private currentNodeClass: NodeClass | null = null;

  parse(nodeClass: NodeClass, packageName: string): ParsedNode {
    this.currentNodeClass = nodeClass;
    // Get base description (handles versioned nodes)
    const description = this.getNodeDescription(nodeClass);
    const outputInfo = this.extractOutputs(description);
    
    return {
      style: this.detectStyle(nodeClass),
      nodeType: this.extractNodeType(description, packageName),
      displayName: description.displayName || description.name,
      description: description.description,
      category: this.extractCategory(description),
      properties: this.propertyExtractor.extractProperties(nodeClass),
      credentials: this.propertyExtractor.extractCredentials(nodeClass),
      isAITool: this.propertyExtractor.detectAIToolCapability(nodeClass),
      isTrigger: this.detectTrigger(description),
      isWebhook: this.detectWebhook(description),
      operations: this.propertyExtractor.extractOperations(nodeClass),
      version: this.extractVersion(nodeClass),
      isVersioned: this.detectVersioned(nodeClass),
      packageName: packageName,
      outputs: outputInfo.outputs,
      outputNames: outputInfo.outputNames
    };
  }
  
  private getNodeDescription(nodeClass: NodeClass): INodeTypeBaseDescription | INodeTypeDescription {
    // Try to get description from the class first
    let description: INodeTypeBaseDescription | INodeTypeDescription | undefined;

    // Check if it's a versioned node using type guard
    if (isVersionedNodeClass(nodeClass)) {
      // This is a VersionedNodeType class - instantiate it
      try {
        const instance = new (nodeClass as new () => VersionedNodeInstance)();
        description = instance.description;
      } catch (e) {
        // Some nodes might require parameters to instantiate
      }
    } else if (typeof nodeClass === 'function') {
      // Try to instantiate to get description
      try {
        const instance = new nodeClass();
        description = instance.description;
      } catch (e) {
        // Some nodes might require parameters to instantiate
        // Try to access static properties
        description = (nodeClass as any).description;
      }
    } else {
      // Maybe it's already an instance
      description = nodeClass.description;
    }

    return description || ({} as any);
  }
  
  private detectStyle(nodeClass: NodeClass): 'declarative' | 'programmatic' {
    const desc = this.getNodeDescription(nodeClass);
    return (desc as any).routing ? 'declarative' : 'programmatic';
  }

  private extractNodeType(description: INodeTypeBaseDescription | INodeTypeDescription, packageName: string): string {
    // Ensure we have the full node type including package prefix
    const name = description.name;
    
    if (!name) {
      throw new Error('Node is missing name property');
    }
    
    if (name.includes('.')) {
      return name;
    }
    
    // Add package prefix if missing
    const packagePrefix = packageName.replace('@n8n/', '').replace('n8n-', '');
    return `${packagePrefix}.${name}`;
  }
  
  private extractCategory(description: INodeTypeBaseDescription | INodeTypeDescription): string {
    return description.group?.[0] ||
           (description as any).categories?.[0] ||
           (description as any).category ||
           'misc';
  }

  private detectTrigger(description: INodeTypeBaseDescription | INodeTypeDescription): boolean {
    // Strategic any assertion for properties that only exist on INodeTypeDescription
    const desc = description as any;

    // Primary check: group includes 'trigger'
    if (description.group && Array.isArray(description.group)) {
      if (description.group.includes('trigger')) {
        return true;
      }
    }

    // Fallback checks for edge cases
    return desc.polling === true ||
           desc.trigger === true ||
           desc.eventTrigger === true ||
           description.name?.toLowerCase().includes('trigger');
  }
  
  private detectWebhook(description: INodeTypeBaseDescription | INodeTypeDescription): boolean {
    const desc = description as any; // INodeTypeDescription has webhooks, but INodeTypeBaseDescription doesn't
    return (desc.webhooks?.length > 0) ||
           desc.webhook === true ||
           description.name?.toLowerCase().includes('webhook');
  }
  
  /**
   * Extracts the version from a node class.
   *
   * Priority Chain:
   * 1. Instance currentVersion (VersionedNodeType's computed property)
   * 2. Instance description.defaultVersion (explicit default)
   * 3. Instance nodeVersions (fallback to max available version)
   * 4. Description version array (legacy nodes)
   * 5. Description version scalar (simple versioning)
   * 6. Class-level properties (if instantiation fails)
   * 7. Default to "1"
   *
   * Critical Fix (v2.17.4): Removed check for non-existent instance.baseDescription.defaultVersion
   * which caused AI Agent to incorrectly return version "3" instead of "2.2"
   *
   * @param nodeClass - The node class or instance to extract version from
   * @returns The version as a string
   */
  private extractVersion(nodeClass: NodeClass): string {
    // Check instance properties first
    try {
      const instance = typeof nodeClass === 'function' ? new nodeClass() : nodeClass;
      // Strategic any assertion - instance could be INodeType or IVersionedNodeType
      const inst = instance as any;

      // PRIORITY 1: Check currentVersion (what VersionedNodeType actually uses)
      // For VersionedNodeType, currentVersion = defaultVersion ?? max(nodeVersions)
      if (inst?.currentVersion !== undefined) {
        return inst.currentVersion.toString();
      }

      // PRIORITY 2: Handle instance-level description.defaultVersion
      // VersionedNodeType stores baseDescription as 'description', not 'baseDescription'
      if (inst?.description?.defaultVersion) {
        return inst.description.defaultVersion.toString();
      }

      // PRIORITY 3: Handle instance-level nodeVersions (fallback to max)
      if (inst?.nodeVersions) {
        const versions = Object.keys(inst.nodeVersions).map(Number);
        if (versions.length > 0) {
          const maxVersion = Math.max(...versions);
          if (!isNaN(maxVersion)) {
            return maxVersion.toString();
          }
        }
      }

      // Handle version array in description (e.g., [1, 1.1, 1.2])
      if (inst?.description?.version) {
        const version = inst.description.version;
        if (Array.isArray(version)) {
          const numericVersions = version.map((v: any) => parseFloat(v.toString()));
          if (numericVersions.length > 0) {
            const maxVersion = Math.max(...numericVersions);
            if (!isNaN(maxVersion)) {
              return maxVersion.toString();
            }
          }
        } else if (typeof version === 'number' || typeof version === 'string') {
          return version.toString();
        }
      }
    } catch (e) {
      // Some nodes might require parameters to instantiate
      // Try class-level properties
    }

    // Handle class-level VersionedNodeType with defaultVersion
    // Note: Most VersionedNodeType classes don't have static properties
    // Strategic any assertion for class-level property access
    const nodeClassAny = nodeClass as any;
    if (nodeClassAny.description?.defaultVersion) {
      return nodeClassAny.description.defaultVersion.toString();
    }

    // Handle class-level VersionedNodeType with nodeVersions
    if (nodeClassAny.nodeVersions) {
      const versions = Object.keys(nodeClassAny.nodeVersions).map(Number);
      if (versions.length > 0) {
        const maxVersion = Math.max(...versions);
        if (!isNaN(maxVersion)) {
          return maxVersion.toString();
        }
      }
    }

    // Also check class-level description for version array
    const description = this.getNodeDescription(nodeClass);
    const desc = description as any; // Strategic assertion for version property
    if (desc?.version) {
      if (Array.isArray(desc.version)) {
        const numericVersions = desc.version.map((v: any) => parseFloat(v.toString()));
        if (numericVersions.length > 0) {
          const maxVersion = Math.max(...numericVersions);
          if (!isNaN(maxVersion)) {
            return maxVersion.toString();
          }
        }
      } else if (typeof desc.version === 'number' || typeof desc.version === 'string') {
        return desc.version.toString();
      }
    }

    // Default to version 1
    return '1';
  }
  
  private detectVersioned(nodeClass: NodeClass): boolean {
    // Check instance-level properties first
    try {
      const instance = typeof nodeClass === 'function' ? new nodeClass() : nodeClass;
      // Strategic any assertion - instance could be INodeType or IVersionedNodeType
      const inst = instance as any;

      // Check for instance baseDescription with defaultVersion
      if (inst?.baseDescription?.defaultVersion) {
        return true;
      }

      // Check for nodeVersions
      if (inst?.nodeVersions) {
        return true;
      }

      // Check for version array in description
      if (inst?.description?.version && Array.isArray(inst.description.version)) {
        return true;
      }
    } catch (e) {
      // Some nodes might require parameters to instantiate
      // Try class-level checks
    }

    // Check class-level nodeVersions
    // Strategic any assertion for class-level property access
    const nodeClassAny = nodeClass as any;
    if (nodeClassAny.nodeVersions || nodeClassAny.baseDescription?.defaultVersion) {
      return true;
    }

    // Also check class-level description for version array
    const description = this.getNodeDescription(nodeClass);
    const desc = description as any; // Strategic assertion for version property
    if (desc?.version && Array.isArray(desc.version)) {
      return true;
    }
    
    return false;
  }

  private extractOutputs(description: INodeTypeBaseDescription | INodeTypeDescription): { outputs?: any[], outputNames?: string[] } {
    const result: { outputs?: any[], outputNames?: string[] } = {};
    // Strategic any assertion for outputs/outputNames properties
    const desc = description as any;

    // First check the base description
    if (desc.outputs) {
      result.outputs = Array.isArray(desc.outputs) ? desc.outputs : [desc.outputs];
    }

    if (desc.outputNames) {
      result.outputNames = Array.isArray(desc.outputNames) ? desc.outputNames : [desc.outputNames];
    }

    // If no outputs found and this is a versioned node, check the latest version
    if (!result.outputs && !result.outputNames) {
      const nodeClass = this.currentNodeClass; // We'll need to track this
      if (nodeClass) {
        try {
          const instance = typeof nodeClass === 'function' ? new nodeClass() : nodeClass;
          // Strategic any assertion for instance properties
          const inst = instance as any;
          if (inst.nodeVersions) {
            // Get the latest version
            const versions = Object.keys(inst.nodeVersions).map(Number);
            if (versions.length > 0) {
              const latestVersion = Math.max(...versions);
              if (!isNaN(latestVersion)) {
                const versionedDescription = inst.nodeVersions[latestVersion]?.description;
            
            if (versionedDescription) {
              if (versionedDescription.outputs) {
                result.outputs = Array.isArray(versionedDescription.outputs) 
                  ? versionedDescription.outputs 
                  : [versionedDescription.outputs];
              }
              
              if (versionedDescription.outputNames) {
                result.outputNames = Array.isArray(versionedDescription.outputNames)
                  ? versionedDescription.outputNames
                  : [versionedDescription.outputNames];
              }
            }
              }
            }
          }
        } catch (e) {
          // Ignore errors from instantiating node
        }
      }
    }
    
    return result;
  }
}