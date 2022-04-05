export interface PolymorphicChildInterface {
  entityId: number | string;
  entityType: string;
}

export interface PolymorphicInterface {
  type: 'children' | 'parent';
  hasMany: boolean;
  primaryColumn?: string;
  entityTypeColumn?: string;
  entityTypeId?: string;
  eager: boolean;
  cascade: boolean;
  deleteBeforeUpdate: boolean;
}

export interface PolymorphicMetadataOptionsInterface
  extends PolymorphicInterface {
  classType: () => Function | Function[] | string | string[];
}

export interface PolymorphicMetadataInterface extends PolymorphicInterface {
  classType: Function | Function[] | string | string[];
  propertyKey: string;
}

export interface PolymorphicDecoratorOptionsInterface {
  deleteBeforeUpdate?: boolean;
  primaryColumn?: string;
  hasMany?: boolean;
  cascade?: boolean;
  eager?: boolean;
  entityTypeColumn?: string;
  entityTypeId?: string;
}

export type PolymorphicChildType = {
  type: 'children';
} & PolymorphicMetadataInterface;

export type PolymorphicParentType = {
  type: 'parent';
} & PolymorphicMetadataInterface;

export type PolymorphicOptionsType =
  | PolymorphicChildType
  | PolymorphicParentType;
