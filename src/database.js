import _ from 'lodash';
import { logWarning, logError, executeSeries } from 'node-bits';
import { Database } from 'node-bits-internal-database';

import {
  flattenSchema, mapComplexType, defineRelationships, defineIndexesForSchema,
  runMigrations, runSeeds,
  buildOptions, READ, WRITE
} from './util';

// helpers
const mapSchema = (schema) => {
  return _.mapValues(schema, (value) => mapComplexType(value));
};

// configure the sequelize specific logic
let sequelize = null;
let database = {};

class Implementation {
  // connect
  connect(config) {
    sequelize = config.connection();
    sequelize.authenticate()
      .catch((err) => {
        logError('Unable to authenticate database connection: ', err);
        sequelize = null;
      });
  }

  rawConnection() {
    return sequelize;
  }

  //schema
  updateSchema(name, schema, db) {
    return sequelize.define(name, mapSchema(schema), defineIndexesForSchema(name, db));
  }

  removeSchema(name, model) {
    if (model) {
      model.drop();
    }
  }

  beforeSynchronizeSchema(config, db) {
    return flattenSchema(db);
  }

  afterSynchronizeSchema(config, models, db) {
    const { forceSync } = config;
    if (forceSync && config.runMigrations) {
      logWarning(`forceSync and runMigrations are mutually exclusive.
        node-bits-sql will prefer forceSync and not run migrations.`);
    }

    const shouldRunMigrations = config.runMigrations && !forceSync;
    const tasks = [
      () => shouldRunMigrations ? runMigrations(sequelize, db.migrations) : Promise.resolve(),
      () => sequelize.sync({ force: forceSync }),
      () => config.runSeeds ? runSeeds(sequelize, models, db, forceSync) : Promise.resolve(),
    ];

    executeSeries(tasks)
      .catch((err) => {
        // see if this is a DatabaseError
        if (err.sql) {
          logError(`${err.sql}\ncaused ${err.parent}`);
        } else {
          logError(err);
        }
      });

    database = { db, models };
  }

  defineRelationships(config, models, db) {
    defineRelationships(sequelize, models, db);
  }

  // CRUD
  findById(model, args) {
    return model.findById(args.id, buildOptions(READ, model, database.db, database.models))
      .then(result => result ? result.dataValues : null);
  }

  find(model, args) {
    const options = buildOptions(READ, model, database.db, database.models);
    return model.findAll({ where: args.query, ...options })
      .then(result => result.map(item => item.dataValues));
  }

  create(model, args) {
    const options = buildOptions(WRITE, model, database.db, database.models);
    return model.create(args.data, { returning: true, ...options });
  }

  update(model, args) {
    const options = buildOptions(WRITE, model, database.db, database.models);
    return model.update(args.data, { where: { id: args.id }, ...options });
  }

  delete(model, args) {
    return model.destroy({ where: { id: args.id } });
  }
};

// export the database
export default (config) => {
  return new Database(config, new Implementation());
};
