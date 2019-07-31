/**
 * @module botbuilder-azure
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Storage, StoreItems } from 'botbuilder';
import { ConnectionPolicy, DocumentClient, RequestOptions, UriFactory, FeedOptions } from 'documentdb';
import * as semaphore from 'semaphore';
import { CosmosDbKeyEscape } from './cosmosDbKeyEscape';
import * as V3StorageProvider from '../node_modules/botbuilder-azure';
import * as validate from 'uuid-validate';

const _semaphore: semaphore.Semaphore = semaphore(1);

// @types/documentdb does not have DocumentBase definition
const DocumentBase: any = require('documentdb').DocumentBase; // tslint:disable-line no-require-imports no-var-requires

/**
 * Additional settings for configuring an instance of `CosmosDbStorage`.
 */
export interface CosmosDbStorageSettings {
    /**
     * The endpoint Uri for the service endpoint from the Azure Cosmos DB service.
     */
    serviceEndpoint: string;
    /**
     * The AuthKey used by the client from the Azure Cosmos DB service.
     */
    authKey: string;
    /**
     * The Database ID.
     */
    databaseId: string;
    /**
     * The Collection ID.
     */
    collectionId: string;
    /**
      * (Optional) Cosmos DB RequestOptions that are passed when the database is created.
      */
    databaseCreationRequestOptions?: RequestOptions;
    /**
      * (Optional) Cosmos DB RequestOptiones that are passed when the document collection is created.
      */
    documentCollectionRequestOptions?: RequestOptions;
    /**
      * (Optional) partitionKey that are passed when the document CosmosDbStorage is created.
      */
    partitionKey?: string;
}

/**
 * @private
 * Internal data structure for storing items in DocumentDB.
 */
interface DocumentStoreItem {
    /**
     * Represents the Sanitized Key and used as PartitionKey on DocumentDB.
     */
    id: string;
    /**
     * Represents the original Id/Key.
     */
    realId: string;
    /**
     * The item itself + eTag information.
     */
    document: any;
}

/** Context object passed to IBotStorage calls. */
export interface IBotStorageContext {
    /** (Optional) ID of the user being persisted. If missing __userData__ won't be persisted.  */
    userId?: string;

    /** (Optional) ID of the conversation being persisted. If missing __conversationData__ and __privateConversationData__ won't be persisted. */
    conversationId?: string;

    /** (Optional) Address of the message received by the bot. */

    /** If true IBotStorage should persist __userData__. */
    persistUserData: boolean;

    /** If true IBotStorage should persist __conversationData__.  */
    persistConversationData: boolean;
}

/** Data values persisted to IBotStorage. */
export interface IBotStorageData {
    /** The bots data about a user. This data is global across all of the users conversations. */
    userData?: any;

    /** The bots shared data for a conversation. This data is visible to every user within the conversation.  */
    conversationData?: any;

    /** 
     * The bots private data for a conversation.  This data is only visible to the given user within the conversation. 
     * The session stores its session state using privateConversationData so it should always be persisted. 
     */
    privateConversationData?: any;
}

/**
 * Middleware that implements a CosmosDB based storage provider for a bot.
 *
 * @remarks
 * The `connectionPolicyConfigurator` handler can be used to further customize the connection to
 * CosmosDB (Connection mode, retry options, timeouts). More information at
 * http://azure.github.io/azure-documentdb-node/global.html#ConnectionPolicy
 */
export class CosmosDbStorage implements Storage {

    private settings: CosmosDbStorageSettings;
    private client: DocumentClient;
    private collectionExists: Promise<string>;
    private documentCollectionCreationRequestOption: RequestOptions;
    private databaseCreationRequestOption: RequestOptions;
    private v3storageClient: V3StorageProvider.AzureBotStorage;

    /**
     * Creates a new ConsmosDbStorage instance.
     *
     * @param settings Setting to configure the provider.
     * @param connectionPolicyConfigurator (Optional) An optional delegate that accepts a ConnectionPolicy for customizing policies. More information at http://azure.github.io/azure-documentdb-node/global.html#ConnectionPolicy
     */
    public constructor(
        settings: CosmosDbStorageSettings,
        connectionPolicyConfigurator: (policy: ConnectionPolicy) => void = null
    ) {
        if (!settings) {
            throw new Error('The settings parameter is required.');
        }

        if (!settings.serviceEndpoint || settings.serviceEndpoint.trim() === '') {
            throw new Error('The settings service Endpoint is required.');
        }

        if (!settings.authKey || settings.authKey.trim() === '') {
            throw new Error('The settings authKey is required.');
        }

        if (!settings.databaseId || settings.databaseId.trim() === '') {
            throw new Error('The settings dataBase ID is required.');
        }

        if (!settings.collectionId || settings.collectionId.trim() === '') {
            throw new Error('The settings collection ID is required.');
        }

        this.settings = {...settings};

        // Invoke collectionPolicy delegate to further customize settings
        const policy: ConnectionPolicy = new DocumentBase.ConnectionPolicy();
        if (connectionPolicyConfigurator && typeof connectionPolicyConfigurator === 'function') {
            connectionPolicyConfigurator(policy);
        }

        this.client = new DocumentClient(settings.serviceEndpoint, { masterKey: settings.authKey }, policy);
        this.databaseCreationRequestOption = settings.databaseCreationRequestOptions;
        this.documentCollectionCreationRequestOption = settings.documentCollectionRequestOptions;

        // Azure DocumentDb State Store
        const docDbClient = new V3StorageProvider.DocumentDbClient({
            host: this.settings.serviceEndpoint,
            masterKey: this.settings.authKey,
            database: this.settings.databaseId,
            collection: this.settings.collectionId
        });

        // v3 storage client
        this.v3storageClient = new V3StorageProvider.AzureBotStorage({ gzipData: false }, docDbClient);

    }

    public extractUserId(key: string): string {
        const keySegments: Array<string> = key.split('/');
        const user_id: string = keySegments.find(segment => {
          return validate(segment);
        });
        return user_id;
    }

    public read(keys: string[]): Promise<StoreItems> {
        
        const userStateKey: string = keys.find(key => {
            return key.includes("users");
        });

        if(userStateKey) {
            const context: IBotStorageContext = {
                userId: this.extractUserId(userStateKey),
                persistUserData: true,
                persistConversationData: false
            };
    
            return new Promise((resolve, reject) => {
                this.v3storageClient.getData(context, (err) => {
                    if (err) return reject();
                    return resolve();
                });
            });
        } else {

            if (!keys || keys.length === 0) {
                // No keys passed in, no result to return.
                return Promise.resolve({});
            }

            const parameterSequence: string = Array.from(Array(keys.length).keys())
                .map((ix: number) => `@id${ ix }`)
                .join(',');
            const parameterValues: {
                name: string;
                value: string;
            }[] = keys.map((key: string, ix: number) => ({
                name: `@id${ ix }`,
                value: CosmosDbKeyEscape.escapeKey(key)
            }));

            const querySpec: {
                query: string;
                parameters: {
                    name: string;
                    value: string;
                }[];
            } = {
                query: `SELECT c.id, c.realId, c.document, c._etag FROM c WHERE c.id in (${ parameterSequence })`,
                parameters: parameterValues
            };

            let options: FeedOptions;

            if (this.settings.partitionKey !== null) {
                options = {
                    partitionKey: this.settings.partitionKey
                };
            }

            return this.ensureCollectionExists().then((collectionLink: string) => {
                return new Promise<StoreItems>((resolve: any, reject: any): void => {
                    const storeItems: StoreItems = {};
                    const query: any = this.client.queryDocuments(collectionLink, querySpec, options);
                    const getNext: any = (q: any): any => {
                        q.nextItem((err: any, resource: any): any => {
                            if (err) {
                                return reject(err);
                            }

                            if (resource === undefined) {
                                // completed
                                return resolve(storeItems);
                            }

                            // push item
                            storeItems[resource.realId] = resource.document;
                            storeItems[resource.realId].eTag = resource._etag;

                            // visit the remaining results recursively
                            getNext(q);
                        });
                    };

                    // invoke the function
                    getNext(query);
                });
            });
        }
    }

    public write(changes: StoreItems): Promise<void> {
        const changesKeys = Object.keys(changes);
        const userStateKey: string = changesKeys.find(change => {
          return change.includes("users");
        });

        const extractUserStateProps = (changes, key) => {
            return changes[key].userProfile;
        }

        if(userStateKey) {
            const context: IBotStorageContext = {
                userId: this.extractUserId(userStateKey),
                persistUserData: true,
                persistConversationData: false
            };
    
            const data: IBotStorageData = {
                userData: {...extractUserStateProps(changes, userStateKey)}
            };
    
            return new Promise((resolve, reject) => {
                this.v3storageClient.saveData(context, data, (err) => {
                    if (err) return reject();
                    return resolve();
                });
            });
        } else {
            if (!changes || Object.keys(changes).length === 0) {
                return Promise.resolve();
            }
            return this.ensureCollectionExists().then(() => {
                return Promise.all(Object.keys(changes).map((k: string) => {
                    const changesCopy: any = {...changes[k]};

                    // Remove etag from JSON object that was copied from IStoreItem.
                    // The ETag information is updated as an _etag attribute in the document metadata.
                    delete changesCopy.eTag;
                    const documentChange: DocumentStoreItem = {
                        id: CosmosDbKeyEscape.escapeKey(k),
                        realId: k,
                        document: changesCopy
                    };

                    return new Promise((resolve: any, reject: any): void => {
                        const handleCallback: (err: any, data: any) => void = (err: any): void => err ? reject(err) : resolve();

                        const eTag: string = changes[k].eTag;
                        if (!eTag || eTag === '*') {
                            // if new item or * then insert or replace unconditionaly
                            const uri: any = UriFactory.createDocumentCollectionUri(this.settings.databaseId, this.settings.collectionId);
                            this.client.upsertDocument(uri, documentChange, { disableAutomaticIdGeneration: true }, handleCallback);
                        } else if (eTag.length > 0) {
                            // if we have an etag, do opt. concurrency replace
                            const uri: any = UriFactory.createDocumentUri(
                                this.settings.databaseId,
                                this.settings.collectionId,
                                documentChange.id
                            );
                            const ac: any = { type: 'IfMatch', condition: eTag };
                            this.client.replaceDocument(uri, documentChange, { accessCondition: ac }, handleCallback);
                        } else {
                            reject(new Error('etag empty'));
                        }
                    });
                })).then(() => {
                    return;
                }); // void
            });
        }
    }

    public delete(keys: string[]): Promise<void> {
        if (!keys || keys.length === 0) {
            return Promise.resolve();
        }

        let options: RequestOptions;

        if (this.settings.partitionKey !== null) {
            options = {
                partitionKey: this.settings.partitionKey
            };
        }

        return this.ensureCollectionExists().then(() =>
            Promise.all(keys.map((k: string) =>
                new Promise((resolve: any, reject: any): void =>
                    this.client.deleteDocument(
                        UriFactory.createDocumentUri(this.settings.databaseId, this.settings.collectionId, CosmosDbKeyEscape.escapeKey(k)),
                        options,
                        (err: any): void =>
                            err && err.code !== 404 ? reject(err) : resolve()
                    )
                )
            ))
        ) // handle notfound as Ok
            .then(() => {
                return;
            }); // void
    }

    /**
     * Delayed Database and Collection creation if they do not exist.
     */
    private ensureCollectionExists(): Promise<string> {
        if (!this.collectionExists) {
            this.collectionExists = new Promise((resolve: Function): void => {
                _semaphore.take(() => {
                    const result: Promise<string> = this.collectionExists ? this.collectionExists :
                        getOrCreateDatabase(this.client, this.settings.databaseId, this.databaseCreationRequestOption)
                            .then((databaseLink: string) => getOrCreateCollection(
                                this.client, databaseLink, this.settings.collectionId, this.documentCollectionCreationRequestOption));
                    _semaphore.leave();
                    resolve(result);
                });
            });
        }

        return this.collectionExists;
    }
}

/**
 * @private
 */
function getOrCreateDatabase(client: DocumentClient, databaseId: string, databaseCreationRequestOption: RequestOptions): Promise<string> {
    const querySpec: {
        query: string;
        parameters: {
            name: string;
            value: string;
        }[];
    } = {
        query: 'SELECT r._self FROM root r WHERE r.id = @id',
        parameters: [{ name: '@id', value: databaseId }]
    };

    return new Promise((resolve: any, reject: any): void => {
        client.queryDatabases(querySpec).toArray((err: any, results: any): void => {
            if (err) { return reject(err); }
            if (results.length === 1) { return resolve(results[0]._self); }

            // create db
            client.createDatabase({ id: databaseId }, databaseCreationRequestOption, (dbCreateErr: any, databaseLink: any) => {
                if (dbCreateErr) { return reject(dbCreateErr); }
                resolve(databaseLink._self);
            });
        });
    });
}

/**
 * @private
 */
function getOrCreateCollection(client: DocumentClient,
    databaseLink: string,
    collectionId: string,
    documentCollectionCreationRequestOption: RequestOptions): Promise<string> {
    const querySpec: {
        query: string;
        parameters: {
            name: string;
            value: string;
        }[];
    } = {
        query: 'SELECT r._self FROM root r WHERE r.id=@id',
        parameters: [{ name: '@id', value: collectionId }]
    };

    return new Promise((resolve: any, reject: any): void => {
        client.queryCollections(databaseLink, querySpec).toArray((err: any, results: any): void => {
            if (err) { return reject(err); }
            if (results.length === 1) { return resolve(results[0]._self); }

            client.createCollection(databaseLink,
                { id: collectionId },
                documentCollectionCreationRequestOption,
                (err2: any, collectionLink: any) => {
                    if (err2) { return reject(err2); }
                    resolve(collectionLink._self);
                });
        });
    });
}
