import 'reflect-metadata';
import {
  Repository,
  getMetadataArgsStorage,
  DeepPartial,
  SaveOptions,
  FindConditions,
  FindManyOptions,
  FindOneOptions,
  ObjectID,
  BaseEntity,
} from 'typeorm';
import { POLYMORPHIC_KEY_SEPARATOR, POLYMORPHIC_OPTIONS } from './constants';
import {
  PolymorphicChildType,
  PolymorphicParentType,
  PolymorphicChildInterface,
  PolymorphicOptionsType,
  PolymorphicMetadataInterface,
  PolymorphicMetadataOptionsInterface,
} from './polymorphic.interface';
import { EntityRepositoryMetadataArgs } from 'typeorm/metadata-args/EntityRepositoryMetadataArgs';
import { RepositoryNotFoundException } from './repository.token.exception';

type PolymorphicHydrationType = {
  key: string;
  type: 'children' | 'parent';
  values: PolymorphicChildInterface[] | PolymorphicChildInterface;
  hasMany: boolean;
};

const entityTypeColumn = (options: PolymorphicMetadataInterface): string =>
  options.entityTypeColumn || 'entityType';
const entityIdColumn = (options: PolymorphicMetadataInterface): string =>
  options.entityTypeId || 'entityId';
const PrimaryColumn = (options: PolymorphicMetadataInterface): string =>
  options.primaryColumn || 'id';

export abstract class AbstractPolymorphicRepository<E> extends Repository<E> {
  private getPolymorphicMetadata(): Array<PolymorphicMetadataInterface> {
    const keys = Reflect.getMetadataKeys(
      (this.metadata.target as Function)['prototype'],
    );

    if (!keys) {
      return [];
    }

    return keys.reduce<Array<PolymorphicMetadataInterface>>(
      (keys: PolymorphicMetadataInterface[], key: string) => {
        if (key.split(POLYMORPHIC_KEY_SEPARATOR)[0] === POLYMORPHIC_OPTIONS) {
          const data: PolymorphicMetadataOptionsInterface & {
            propertyKey: string;
          } = Reflect.getMetadata(
            key,
            (this.metadata.target as Function)['prototype'],
          );

          if (data && typeof data === 'object') {
            let classType;
            if (data.classType instanceof Function) {
              classType = data.classType();
            } else {
              classType = data.classType;
            }
            keys.push({
              ...data,
              classType,
            });
          }
        }

        return keys;
      },
      [],
    );
  }

  protected getSubRelationProperty(
    relationName: string,
  ): { property: string; relationName: string } | null {
    if (!relationName || !relationName.includes('.')) {
      return null;
    }
    let result = {
      property: relationName.substr(0, relationName.indexOf('.')),
      relationName:
        relationName.indexOf('.') + 1 < relationName.length
          ? relationName.substr(relationName.indexOf('.') + 1)
          : null,
    };
    if (!result.property || !result.relationName) {
      return null;
    }
    return result;
  }

  protected isPolymorph(): boolean {
    return Reflect.hasOwnMetadata(
      POLYMORPHIC_OPTIONS,
      (this.metadata.target as Function)['prototype'],
    );
  }

  protected isChildren(
    options: PolymorphicChildType | PolymorphicParentType,
  ): options is PolymorphicChildType {
    return options.type === 'children';
  }

  protected isParent(
    options: PolymorphicChildType | PolymorphicParentType,
  ): options is PolymorphicParentType {
    return options.type === 'parent';
  }

  public async hydrateMany(entities: E[], relations: string[]): Promise<E[]> {
    return Promise.all(entities.map((ent) => this.hydrateOne(ent, relations)));
  }

  public async hydrateOne(entity: E, relations: string[]): Promise<E> {
    const metadata = this.getPolymorphicMetadata();
    return this.hydratePolymorphsAndNestedPolymorph(
      entity,
      metadata,
      relations,
    );
  }

  sortRelationByThoseStartWithAPolymorphAndNot(
    options: PolymorphicMetadataInterface[],
    relations: string[] = [],
  ) {
    let result = {
      startWithPolymorphic: [],
      others: [],
    };
    let polymorphicRelationName = options.map((element) => element.propertyKey);
    // let subRelation = relations.map(relation => this.getSubRelationProperty(relation)).map(element=>element.property);
    for (let relation of relations) {
      let propertyPrefix = this.getSubRelationProperty(relation)?.property;
      if (
        polymorphicRelationName.includes(relation) ||
        (propertyPrefix && polymorphicRelationName.includes(propertyPrefix))
      ) {
        result.startWithPolymorphic.push(relation);
      } else {
        result.others.push(relation);
      }
    }
    return result;
  }

  private async hydratePolymorphsAndNestedPolymorph(
    entity: E,
    options: PolymorphicMetadataInterface[],
    relations: string[] = [],
  ) {
    let relationSorted = this.sortRelationByThoseStartWithAPolymorphAndNot(
      options,
      relations,
    );
    let polymorphicAndNestrelationStartingWithAPolymorphicRelation =
      relationSorted.startWithPolymorphic;
    let nestedRelationThatComesFromElseWhere = relationSorted.others;
    if (polymorphicAndNestrelationStartingWithAPolymorphicRelation.length) {
      entity = await this.hydratePolymorphs(
        entity,
        options,
        polymorphicAndNestrelationStartingWithAPolymorphicRelation,
      );
    }
    let propertyNames = this.getCurrentPropertyNamesFromNestedRelations(
      nestedRelationThatComesFromElseWhere,
    );
    for (let propertyName of propertyNames) {
      if (propertyName in entity) {
        let relationLinkedToThisPropertyName = this.getSubRelationForPropertyName(
          propertyName,
          nestedRelationThatComesFromElseWhere,
        );
        if (Array.isArray(entity[propertyName])) {
          entity[propertyName] = await this.hydrateNonPolymorphs(
            entity[propertyName],
            relationLinkedToThisPropertyName,
          );
        } else if (entity[propertyName]) {
          entity[propertyName] = await this.hydrateNonPolymorph(
            entity[propertyName],
            relationLinkedToThisPropertyName,
          );
        }
      }
    }
    return entity;
  }

  private getSubRelationForPropertyName(
    propertyName: string,
    relations: string[],
  ): string[] {
    return relations
      .filter(
        (element) =>
          this.getSubRelationProperty(element)?.property == propertyName,
      )
      .map((element) => this.getSubRelationProperty(element))
      .map((element) => element.relationName);
  }

  async hydrateNonPolymorph(entity: E, relationToLoad: string[]): Promise<E> {
    let payload: E[] = [entity];
    let result = await this.hydrateNonPolymorphs(payload, relationToLoad);
    return result.find((element) => true);
  }

  async hydrateNonPolymorphs(
    entities: E[],
    relationToLoad: string[],
  ): Promise<E[]> {
    if (entities.length) {
      entities = await Promise.all(
        entities.map((element) => {
          let value = element.constructor.name;
          let repo = this.findRepository(value as any) as any;
          return repo.hydratePolymorphsAndNestedPolymorph(
            element,
            repo.getPolymorphicMetadata(),
            relationToLoad,
          );
        }),
      );
      // let entity = entities.find(() => true);
      // let value = entity.constructor.name;
      // let repo = this.findRepository(value as any) as any;
      // if (repo.hydratePolymorphsAndNestedPolymorph) {
      //   Promise.all(entities.map((entity) => this.hydrateOne(ent, relations)))
      //   entities = await repo.hydratePolymorphsAndNestedPolymorph(
      //     entities,
      //     repo.getPolymorphicMetadata(),
      //     relationToLoad,
      //   );
      // }
    }
    return entities;
  }

  private getCurrentPropertyNamesFromNestedRelations(
    relations: string[],
  ): string[] {
    let result = relations
      .map((relationName) => this.getSubRelationProperty(relationName))
      .filter((element) => element)
      .map((element) => element.property);
    return [...new Set(result)];
  }

  private async hydratePolymorphs(
    entity: E,
    options: PolymorphicMetadataInterface[],
    polymorphicRelationsAndNestedRelationsOnElements: string[] = [],
  ): Promise<E> {
    let availablePolymorphicKeys = options.map(
      (element) => element.propertyKey,
    );
    let propertyKeyForThisEntity = polymorphicRelationsAndNestedRelationsOnElements
      .map((item) => this.getSubRelationProperty(item))
      .filter((item) => item)
      .map((item) => item.property);
    let polymorphicPropertyNameToKeep = polymorphicRelationsAndNestedRelationsOnElements.filter(
      (element) =>
        availablePolymorphicKeys.includes(element) ||
        propertyKeyForThisEntity.includes(element),
    );
    options = options.filter((element) =>
      polymorphicPropertyNameToKeep.includes(element.propertyKey),
    );
    const values = await Promise.all(
      options.map((option: PolymorphicMetadataInterface) =>
        this.hydrateEntities(
          entity,
          option,
          this.transformRelationToSubRelationOfGivenProperty(
            option,
            polymorphicRelationsAndNestedRelationsOnElements,
          ),
        ),
      ),
    );

    return values.reduce<E>((e: E, vals: PolymorphicHydrationType) => {
      const values =
        vals.type === 'parent' && Array.isArray(vals.values)
          ? vals.values.filter((v) => typeof v !== 'undefined' && v !== null)
          : vals.values;
      e[vals.key] =
        (vals.type === 'parent' || !vals.hasMany) && Array.isArray(values)
          ? values[0]
          : values; // TODO should be condition for !hasMany
      return e;
    }, entity);
  }

  private transformRelationToSubRelationOfGivenProperty(
    option: PolymorphicMetadataInterface,
    relations: string[],
  ) {
    return relations
      .map((relationName) => this.getSubRelationProperty(relationName))
      .filter((element) => element && element.property == option.propertyKey)
      .map((subProperty) => subProperty.relationName);
  }

  private async hydrateEntities(
    entity: E,
    options: PolymorphicMetadataInterface,
    nestedRelationToLoad: string[] = [],
  ): Promise<PolymorphicHydrationType> {
    let entityTypes: (Function | string)[] =
      options.type === 'parent'
        ? [entity[entityTypeColumn(options)]]
        : Array.isArray(options.classType)
        ? options.classType
        : [options.classType];
    // TODO if not hasMany, should I return if one is found?
    entityTypes = entityTypes.filter((item) => item);
    const results = await Promise.all(
      entityTypes.map((type: Function) =>
        this.findPolymorphs(entity, type, options, nestedRelationToLoad),
      ),
    );

    return {
      key: options.propertyKey,
      type: options.type,
      hasMany: options.hasMany,
      values: (options.hasMany &&
      Array.isArray(results) &&
      results.length > 0 &&
      Array.isArray(results[0])
        ? results.reduce<PolymorphicChildInterface[]>(
            (
              resultEntities: PolymorphicChildInterface[],
              entities: PolymorphicChildInterface[],
            ) => entities.concat(...resultEntities),
            results as PolymorphicChildInterface[],
          )
        : results) as PolymorphicChildInterface | PolymorphicChildInterface[],
    };
  }

  private async findPolymorphs(
    parent: E,
    entityType: Function,
    options: PolymorphicMetadataInterface,
    nestedRelationToLoad: string[] = [],
  ): Promise<PolymorphicChildInterface[] | PolymorphicChildInterface | never> {
    const repository = this.findRepository(entityType);
    let commonRelationProperty = repository.metadata.relations.map(
      (element) => element.propertyName,
    );
    let polymorphicRelationProperty = options.propertyKey;
    let filteredNestedRelation = nestedRelationToLoad.filter(
      (element: string) => {
        if (
          element == polymorphicRelationProperty ||
          commonRelationProperty.includes(element)
        ) {
          return true;
        }
        let nestedRelation = this.getSubRelationProperty(element);
        return (
          nestedRelation &&
          (nestedRelation.property == polymorphicRelationProperty ||
            commonRelationProperty.includes(nestedRelation.property))
        );
      },
    );

    return repository[options.hasMany ? 'find' : 'findOne'](
      options.type === 'parent'
        ? {
            where: {
              id: parent[entityIdColumn(options)],
            },
            relations: filteredNestedRelation,
          }
        : {
            where: {
              [entityIdColumn(options)]: parent[PrimaryColumn(options)],
              [entityTypeColumn(options)]:
                // @ts-expect-error
                parent.name || parent.constructor.name,
            },
            relations: filteredNestedRelation,
          },
    );
  }

  private findRepository(
    entityType: Function,
  ): Repository<PolymorphicChildInterface | never> {
    const repositoryToken = this.resolveRepositoryToken(entityType);

    const repository: Repository<PolymorphicChildInterface> =
      repositoryToken !== entityType
        ? this.manager.getCustomRepository(repositoryToken)
        : this.manager.getRepository(repositoryToken);

    if (!repository) {
      throw new RepositoryNotFoundException(repositoryToken);
    }

    return repository;
  }

  private resolveRepositoryToken(token: Function): Function | never {
    const tokens = getMetadataArgsStorage().entityRepositories.filter(
      (value: EntityRepositoryMetadataArgs) =>
        //@ts-expect-error
        value.entity === token || value.entity?.name === token,
    );
    return tokens[0] ? tokens[0].target : token;
  }

  save<T extends DeepPartial<E>>(
    entities: T[],
    options: SaveOptions & {
      reload: false;
    },
  ): Promise<T[]>;

  save<T extends DeepPartial<E>>(
    entities: T[],
    options?: SaveOptions,
  ): Promise<(T & E)[]>;

  save<T extends DeepPartial<E>>(
    entity: T,
    options?: SaveOptions & {
      reload: false;
    },
  ): Promise<T>;

  public async save<T extends DeepPartial<E>>(
    entityOrEntities: T | Array<T>,
    options?: SaveOptions & { reload: false },
  ): Promise<(T & E) | Array<T & E> | T | Array<T>> {
    if (!this.isPolymorph()) {
      return Array.isArray(entityOrEntities)
        ? super.save(entityOrEntities, options)
        : super.save(entityOrEntities, options);
    }

    const metadata = this.getPolymorphicMetadata();

    metadata.map((options: PolymorphicOptionsType) => {
      if (this.isParent(options)) {
        (Array.isArray(entityOrEntities)
          ? entityOrEntities
          : [entityOrEntities]
        ).map((entity: E | DeepPartial<E>) => {
          const parent = entity[options.propertyKey];

          if (!parent || entity[entityIdColumn(options)] !== undefined) {
            return entity;
          }

          /**
           * Add parent's id and type to child's id and type field
           */
          entity[entityIdColumn(options)] = parent[PrimaryColumn(options)];
          entity[entityTypeColumn(options)] = parent.constructor.name;
          return entity;
        });
      }
    });

    /**
     * Check deleteBeforeUpdate
     */
    Array.isArray(entityOrEntities)
      ? await Promise.all(
          (entityOrEntities as Array<T>).map((entity) =>
            this.deletePolymorphs(entity, metadata),
          ),
        )
      : await this.deletePolymorphs(entityOrEntities as T, metadata);

    return Array.isArray(entityOrEntities)
      ? super.save(entityOrEntities, options)
      : super.save(entityOrEntities, options);
  }

  private async deletePolymorphs(
    entity: DeepPartial<E>,
    options: PolymorphicMetadataInterface[],
  ): Promise<void | never> {
    await Promise.all(
      options.map(
        (option: PolymorphicMetadataInterface) =>
          new Promise((resolve) => {
            if (!option.deleteBeforeUpdate) {
              resolve(Promise.resolve());
            }

            const entityTypes = Array.isArray(option.classType)
              ? option.classType
              : [option.classType];

            // resolve to singular query?
            resolve(
              Promise.all(
                entityTypes.map((type: () => Function | Function[]) => {
                  const repository = this.findRepository(type);

                  repository.delete({
                    [entityTypeColumn(option)]: type,
                    [entityIdColumn(option)]: entity[PrimaryColumn(option)],
                  });
                }),
              ),
            );
          }),
      ),
    );
  }

  isThisRelationIntoCommonTypeOrmRelation(
    relationName: string,
    currentEntityRelationMetadata = null,
  ): boolean {
    let relationProperty =
      this.getSubRelationProperty(relationName) || relationName;
    let relationMetadata =
      currentEntityRelationMetadata ||
      this.metadata.relations.find(
        (element) => element.propertyName == relationProperty,
      );
    if (
      relationMetadata &&
      typeof relationProperty !== 'string' &&
      relationProperty.relationName
    ) {
      return this.isThisRelationIntoCommonTypeOrmRelation(
        relationProperty.relationName,
        relationMetadata,
      );
    }
    return !!relationMetadata;
  }

  find(options?: FindManyOptions<E>): Promise<E[]>;

  find(conditions?: FindConditions<E>): Promise<E[]>;

  public async find(
    optionsOrConditions?: FindConditions<E> | FindManyOptions<E>,
  ): Promise<E[]> {
    const metadata = this.getPolymorphicMetadata();
    let modifiedOptionsOrConditions = Object.assign({}, optionsOrConditions);
    if (
      modifiedOptionsOrConditions &&
      //@ts-expect-error
      Array.isArray(modifiedOptionsOrConditions.relations)
    ) {
      //@ts-expect-error
      modifiedOptionsOrConditions.relations = modifiedOptionsOrConditions.relations.filter(
        (element) => this.isThisRelationIntoCommonTypeOrmRelation(element),
      );
    }
    const results = await super.find(modifiedOptionsOrConditions);

    let options = optionsOrConditions as any;
    let relations = options?.relations || [];
    let polymorphicRelationsAndNestedRelationsOnElements = this.filterRelationToKeepOnlyPolymorphicRelationsOrNestedRelations(
      metadata,
      relations,
    );
    if (!polymorphicRelationsAndNestedRelationsOnElements.length) {
      return results;
    }
    return this.hydrateMany(results, relations);
  }

  private filterRelationToKeepOnlyPolymorphicRelationsOrNestedRelations(
    metadata: Array<PolymorphicMetadataInterface>,
    relationNames: string[],
  ) {
    return relationNames.filter(
      (relationName) =>
        this.isThisRelationAPolymorphicRelations(metadata, relationName) ||
        this.isThisRelationNested(relationName),
    );
  }

  private isThisRelationAPolymorphicRelations(
    metadata: Array<PolymorphicMetadataInterface>,
    relationName: string,
  ): boolean {
    return !!metadata.find((element) => element.propertyKey == relationName);
  }

  private isThisRelationNested(relationName: string): boolean {
    return !!this.getSubRelationProperty(relationName);
  }

  findOne(
    id?: string | number | Date | ObjectID,
    options?: FindOneOptions<E>,
  ): Promise<E | undefined>;

  findOne(options?: FindOneOptions<E>): Promise<E | undefined>;

  findOne(
    conditions?: FindConditions<E>,
    options?: FindOneOptions<E>,
  ): Promise<E | undefined>;

  public async findOne(
    idOrOptionsOrConditions?:
      | string
      | number
      | Date
      | ObjectID
      | FindConditions<E>
      | FindOneOptions<E>,
    optionsOrConditions?: FindConditions<E> | FindOneOptions<E>,
  ): Promise<E | undefined> {
    let modifiedIdOrOptionsOrConditions = idOrOptionsOrConditions;
    if (typeof idOrOptionsOrConditions === 'object') {
      modifiedIdOrOptionsOrConditions = Object.assign(
        {},
        idOrOptionsOrConditions,
      );
      if (
        modifiedIdOrOptionsOrConditions &&
        //@ts-expect-error
        Array.isArray(modifiedIdOrOptionsOrConditions.relations)
      ) {
        //@ts-expect-error
        modifiedIdOrOptionsOrConditions.relations = modifiedIdOrOptionsOrConditions.relations.filter(
          (element) => this.isThisRelationIntoCommonTypeOrmRelation(element),
        );
      }
    }

    let modifiedOptionsOrConditions =
      typeof optionsOrConditions === 'object'
        ? Object.assign({}, optionsOrConditions)
        : optionsOrConditions;
    if (
      typeof modifiedOptionsOrConditions === 'object' &&
      //@ts-expect-error
      Array.isArray(modifiedOptionsOrConditions.relations)
    ) {
      //@ts-expect-error
      modifiedOptionsOrConditions.relations = modifiedOptionsOrConditions.relations.filter(
        (element) => this.isThisRelationIntoCommonTypeOrmRelation(element),
      );
    }

    let entity =
      modifiedIdOrOptionsOrConditions &&
      (typeof modifiedIdOrOptionsOrConditions === 'string' ||
        typeof modifiedIdOrOptionsOrConditions === 'number' ||
        typeof modifiedIdOrOptionsOrConditions === 'object') &&
      modifiedOptionsOrConditions
        ? await super.findOne(
            modifiedIdOrOptionsOrConditions as
              | number
              | string
              | ObjectID
              | Date,
            modifiedOptionsOrConditions as
              | FindConditions<E>
              | FindOneOptions<E>,
          )
        : await super.findOne(
            modifiedOptionsOrConditions as
              | FindConditions<E>
              | FindOneOptions<E>,
          );

    const polymorphicMetadata = this.getPolymorphicMetadata();
    let options = optionsOrConditions as any;
    let relations = options?.relations || [];
    let relationsFromFirstArgument = idOrOptionsOrConditions as any;
    relations = [
      ...relations,
      ...(relationsFromFirstArgument?.relations || []),
    ];
    if (entity) {
      entity = await this.hydrateOne(entity, relations);
    }
    return entity;
  }

  create(): E;

  create(entityLikeArray: DeepPartial<E>[]): E[];

  create(entityLike: DeepPartial<E>): E;

  create(
    plainEntityLikeOrPlainEntityLikes?: DeepPartial<E> | DeepPartial<E>[],
  ): E | E[] {
    const metadata = this.getPolymorphicMetadata();
    const entity = super.create(plainEntityLikeOrPlainEntityLikes as any);
    if (!metadata) {
      return entity;
    }
    metadata.forEach((value: PolymorphicOptionsType) => {
      entity[value.propertyKey] =
        plainEntityLikeOrPlainEntityLikes[value.propertyKey];
    });

    return entity;
  }

  /// TODO implement remove and have an option to delete children/parent
}
