'use strict';

// --- Dependencies ---
var assert = require('assert');
var inherits = require('util').inherits;

var debug = require('debug')('arkivo:sync');
var trace = require('debug')('arkivo:trace');

var B = require('bluebird');
var co = B.coroutine.bind(B);

var zotero = require('./zotero');

var properties = Object.defineProperties;
var slice = Array.prototype.slice;

var common = require('./common');
var extend = common.extend;

var plugins = require('./plugins');

/** @module arkivio */

var MAX_BATCH_SIZE = 50;

/**
 * A synchronization session; it keeps track of the session
 * state for a single subscription and is created by the
 * associated Synchronizer instance.
 *
 * @class Session
 * @constructor
 */
function Session(subscription, synchronizer) {

  /**
   * The subscription to be synchronized.
   *
   * @property subscription
   * @type Subscription
   */
  this.subscription = subscription;

  /**
   * This session's Synchronizer instance.
   *
   * @property synchronizer
   * @type Synchronizer
   */
  this.synchronizer = synchronizer || Synchronizer.instance;

  /**
   * Changed items downloaded during synchronization
   * indexed by their Zotero keys.
   *
   * @property items
   * @type Object
   */
  this.items = {};

  /**
   * Cache for downloaded attachments.
   *
   * @property attachments
   * @type Object
   */
  this.attachments = {};

  /**
   * The keys of all newly created items.
   *
   * @property created
   * @type {Array<String>}
   */
  this.created = [];

  /**
   * The keys of all updated items.
   *
   * @property updated
   * @type {Array<String>}
   */
  this.updated = [];

  /**
   * The keys of all deleted items.
   *
   * @property deleted
   * @type {Array<String>}
   */
  this.deleted = [];

  /**
   * The subscription's remote version. If this version differs
   * from the subscription's current version, this means that
   * updated data is available.
   *
   * @see .modified
   *
   * @property version
   * @type Number
   */
  this.version = undefined;
}

properties(Session.prototype, {
  /**
   * The session id is the same as the id of the
   * associated subscription.
   *
   * @property id
   * @type String
   */
  id: {
    get: function () {
      if (!this.subscription) return undefined;
      return this.subscription.id;
    }
  },

  /**
   * Whether or not the session's subscription has been modified
   * on the remote side; if true, this means that new or updated
   * items can be downloaded.
   *
   * Note: this property is false by default; its value
   * is meaningful only after `.update` has finished.
   *
   * @property modified
   * @type Boolean
   */
  modified: {
    get: function () {
      return this.version !== undefined &&
        this.version > this.subscription.version;
    }
  }

});

/**
 * Connect to the Zotero API using the Zotero client instance
 * of the Synchronizer of the current Session; by using the
 * Zotero client you can be sure that your requests have the
 * same credentials that were used by synchronization session.
 *
 * @method get
 *
 * @param {String} [path] The path to get (defaults to
 *   the associated subscription's URL).
 * @param {Object} [options] Additional URL parameters.
 * @param {Object} [headers] Additional HTTP headers.
 *
 * @return {Zotero.Message} The Zotero API response.
 */
Session.prototype.get = function (path, options, headers) {
  var z = this.synchronizer.zotero;
  var s = this.subscription;

  path    = path || s.path;
  options = extend({}, s.params, options);
  headers = extend({}, s.headers, headers);

  return z.get(path, options, headers);
};

/**
 * Fetches a batch of items from Zotero.
 *
 * @method fetch
 * @param {Array} batch A list of item keys
 *
 * @return {Promise<Zotero.Message>}
 */
Session.prototype.fetch = function (batch) {
  var path = [this.subscription.library, 'items'].join('/');

  return this.get(path, {
    format: 'json', include: 'data', itemKey: batch.join(',')
  });
};


/**
 * Fetches the set of an item's children from Zotero.
 *
 * @method children
 * @param {Object} item The parent item
 *
 * @return {Promise<Zotero.Message>}
 */
Session.prototype.children = function (item) {
  var path =
    [this.subscription.library, 'items', item.key, 'children'].join('/');

  return this.get(path, { format: 'json', include: 'data' });
};


/**
 * Downloads an item's file attachment and store
 * it in the local attachment cache.
 *
 * @method attachment
 * @return {Promise<Zotero.Message>}
 */
Session.prototype.attachment = function (item) {

  // TODO add semaphore in order to support parallel
  // execution of plugins!

  if (this.attachments[item.key])
    return B.resolve(this.attachments[item.key]);

  return this
    .get([
      this.subscription.library, 'items', item.key, 'file'
    ].join('/'))

    .tap(function (message) {
      this.attachments[item.key] = message;
    }.bind(this));
};


/**
 * Executes the synchronization session by first fetching the
 * subscription's versions from Zotero and downloading the
 * associated items if necessary.
 *
 * Note: if the session is interrupted in process
 * because the Zotero library has been updated remotely,
 * the session will pause and retry to synchronize
 * `retry` times.
 *
 * @method execute
 *
 * @param {Boolean} [skip = false] Set this to true
 *   to skip downloading items.
 * @param {Number} [retry = 3]
 *   The maximum number of retries.
 *
 * @return {Promise<this>}
 *   Eventually returns this Session instance.
 */
Session.prototype.execute = co(function* (skip, retry) {
  if (retry == null) retry = 3;

  try {
    yield this.update();

    if (!skip) yield this.download();

  } catch (error) {
    if (!retry || !(error instanceof InterruptedError)) throw error;

    this.debug('synchronization interrupted, resuming in %ds...',
      error.resume / 1000);

    yield B.delay(error.resume);
    yield this.execute(skip, --retry);
  }

  return this;
});

/**
 * Compares a Zotero API versions response with the associated
 * subscription's current versions and updates the `.created`,
 * `.updated` and `.deleted` arrays accordingly.
 *
 * Note: Calling this method resets the arrays
 * mentioned above!
 *
 * @method diff
 * @private
 *
 * @chainable
 *
 * @param {Object} versions The new versions.
 * @param {Object} [earlier] The old versions used
 *   for comparison.
 */
Session.prototype.diff = function (versions, earlier) {
  versions = versions || this.versions;
  earlier  = earlier  || this.subscription.versions;

  assert(typeof versions === 'object');
  assert(typeof earlier  === 'object');

  this.created.length = 0;
  this.updated.length = 0;
  this.deleted.length = 0;

  var key;

  // Current items have either been created,
  // updated, or are unchanged.
  for (key in versions) {
    if (earlier.hasOwnProperty(key)) {

      if (versions[key] > earlier[key])
        this.updated.push(key);

    } else {
      this.created.push(key);
    }
  }

  // Check earlier items for deletions.
  for (key in earlier)
    if (!versions.hasOwnProperty(key)) this.deleted.push(key);

  return this;
};


/**
 * Fetches the latest library versions for this subscription
 * from Zotero. Depending on the size of the subscription's
 * target this method may require multiple HTTP requests
 * to complete.
 *
 * @method update
 *
 * @throws {InterruptedError} If a version mismatch
 *   is detected during the update process.
 *
 * @return {Promise<this>} The updated session.
 */
Session.prototype.update = co(function* () {
  var s = this.subscription;
  this.version = undefined;

  this.debug('requesting "%s"...', s.path);

  var message = yield this.get(s.path, {
    limit: 5000,
    format: 'versions'
  });

  if (message.unmodified)
    return this.debug('not modified');

  assert.equal('json', message.type);

  this.debug('new version detected: %d (was %d)',
    message.version, s.version);

  this.version  = message.version;
  this.versions = message.data;

  if (message.multi) {
    while (!message.done) {
      message = yield message.next();

      this.check(message.version);
      assert.equal('json', message.type);

      extend(this.versions, message.data);
    }
  }

  this.diff();

  this.debug('versions received: %d created, %d updated, %d deleted',
      this.created.length, this.updated.length, this.deleted.length);

  return this;
});


/**
 * Checks whether or not the passed-in version matches the
 * version of the current sync session. If the version does
 * not match, an InterruptedError is thrown. That is, this
 * method either returns true or throws an error.
 *
 * @method check
 * @private
 *
 * @param {Number} version The version to check.
 *
 * @throws {InterruptedError} If the the version does not match.
 * @return {true} True if the version matches.
 */
Session.prototype.check = function (version) {
  if (this.version === undefined) return true;
  if (this.version === version)   return true;

  this.debug('version mismatch detected: %d (was %d)!',
    version, this.version);

  throw new InterruptedError('version mismatch detected');
};


/**
 * Downloads all items that have been created or updated in the
 * period represented by the this synchronization session.
 *
 * Downloaded items are stored in `.items`. If an item is already
 * present it will be skipped unless its version has changed.
 *
 * Note: This method does not reset the `.items` store; this
 * means you can safely call it again after it has been
 * interrupted and previously downloaded items will be retained.
 *
 * @method download
 *
 * @params {Array<String>} [keys] The keys of all items
 *   to download. Defaults to all created/updated items.
 *
 * @throws {InterruptedError} If a version mismatch
 *   is detected during the download process.
 *
 * @return {Promise<this>}
 *   A promise for this session when the downloads
 *   have finished.
 */
Session.prototype.download = co(function* (keys) {
  keys = keys || this.updated.concat(this.created);

  if (!keys.length) return this;

  var i = 0, batch, item, key;

  this.debug('%d items to download', keys.length);

  // Subtle: the keys array may grow during loop
  // execution, because attachment's parent items
  // are added on the fly to ensure they will be
  // fetched with the next batch!
  while (i < keys.length) {
    batch = [];

    // Select a batch of items to download, skipping previously
    // downloaded items if they still have the same version.
    for (; i < keys.length; ++i) {
      key  = keys[i];
      item = this.items[key];

      if (!item || item.version !== this.versions[key]) {
        batch.push(key);

        if (batch.length >= MAX_BATCH_SIZE) { i++; break; }
      }
    }

    // Break early if the selection is empty!
    if (!batch.length) continue;

    this.debug('requesting %d items...', batch.length);

    yield this.receive(yield this.fetch(batch), keys);
  }

  this.debug('downloaded %d item(s)', keys.length);

  return this;
});


/**
 * @method receive
 * @private
 *
 * @throws {InterruptedError}
 * @return {Promise<Array>} The items received
 */
Session.prototype.receive = co(function* (message, keys) {

  // Throws InterruptedError if the version has changed.
  // This will abort the current download, but keep the
  // items that have been downloaded already.
  // When the synchronization resumes, these items will
  // only be downloaded again if their version changed.
  this.check(message.version);

  var items = message.data;
  var j, jj, parent, item;

  assert.equal('json', message.type);

  this.debug('%d items received...', items.length);

  for (j = 0, jj = items.length; j < jj; ++j) {
    item = items[j];

    this.items[item.key] = item;

    // Add parent's key to list of keys to fetch,
    // since most plugins will need to access the
    // parent item's data!
    if (keys !== undefined && (parent = getParent(item))) {
      if (keys.indexOf(parent) === -1) {
        this.debug('requesting additional parent item...');
        keys.push(parent);
      }
    }

    // Fetch child items since plugin's may need
    // them -- by fetching them now, we ensure
    // that the versions are in-sync!
    if (hasChildren(item)) {
      this.debug('fetching children of "%s"', item.key);

      // Save the children both inline and in the items array!
      item.children =
        yield this.receive(yield this.children(item));
    }
  }

  return items;
});


/**
 * @method debug
 * @private
 */
Session.prototype.debug = function (message) {
  debug.apply(null,
    ['[%s] ' + message, this.id].concat(slice.call(arguments, 1)));

  return this;
};

/**
 * The Synchronizer handles synchronizing Subscriptions
 * by fetching and comparing the latest version from
 * the Zotero API servers.
 *
 * @class Synchronizer
 * @constructor
 */
function Synchronizer() {
  /**
   * The Zotero client instance used by the Synchronizer
   * to connect to the Zotero API.
   *
   * @property zotero
   * @type {zotero.Client}
   */
  this.zotero = zotero;
}


/**
 * Synchronizes the passed-in subscription. If the optional
 * `skip` parameter is set to true, only the item versions
 * will be updated, but not the data itself, and no plugins
 * will be called.
 *
 * @method synchronize
 *
 * @param {Subscription} sub The subscription to synchronize.
 * @param {Boolean} [skip = false] Whether or not to skip
 *   item download and plugin dispatch.
 *
 * @throws {Subscription.UpdateError} If the Subscription
 *   has been removed during the sync process.
 *
 * @return {Promise<Session>}
 *   A promise for the synchronizer Session.
 */
Synchronizer.prototype.synchronize = co(function* (sub, skip) {
  var session = new Session(sub, this);

  debug('[%s] processing subscription...', sub.id);

  sub.touch();

  yield session.execute(skip);

  if (session.modified) {
    if (!skip) yield this.dispatch(session);

    sub.update({
      version: session.version,
      versions: session.versions
    });
  }

  return session;
});


/**
 * This is a short-hand method that simply calls
 * `synchronize` with the `skip` parameter set to true.
 *
 * @method update
 * @see Synchronizer.synchronize
 *
 * @param {Subscription} sub The subscription to update.
 *
 * @return {Promise<Session>}
 *   A promise for synchronizer Session.
 */
Synchronizer.prototype.update = function (sub) {
  return this.synchronize(sub, true);
};


/**
 * Dispatches the synchronization `session` to all
 * plugins configured for the associated subscription.
 *
 * @method dispatch
 * @private
 *
 * @return {Promise<this>}
 */
Synchronizer.prototype.dispatch = co(function* (session) {

  debug('[%s] dispatching sync session data to plugins...', session.id);

  yield B
    .map(session.subscription.plugins, function (plugin) {

      if (!plugins.available[plugin.name]) {
        debug('[%s] plugin %s not available, skipping...',
          session.id, plugin.name);

        return null;
      }

      debug('[%s] processing data with "%s" plugin...',
        session.id, plugin.name);

      // Wrap plugin invocation in a promise; this is
      // necessary, because we want to allow plugin
      // authors to choose between promises and callbacks.
      return new B(function (resolve, reject) {

        function callback(error) {
          if (error) return reject(error);
          resolve();
        }

        var done = plugins
          .use(plugin.name, plugin.options || {})
          .process(session, callback);


        if (done && done.then)
          done.then(resolve, reject);

      }).catch(function (error) {
        debug('[%s] plugin %s failed: %s',
            session.id, plugin.name, error.message);
        trace(error.stack);
        throw error;
      });

    }, { concurrency: 1 });


  debug('[%s] finished processing plugins', session.id);

  return this;
});




// --- Singleton ---
Synchronizer.instance = new Synchronizer();

// --- Errors ---

/**
 * Error thrown when the Zotero library version
 * changes during a synchronizater session.
 *
 * @class InterruptedError
 * @extends Error
 */
function InterruptedError(message) {
  this.message = message;
  this.name = 'InterruptedError';

  Error.captureStackTrace(this, InterruptedError);
}

inherits(InterruptedError, Error);

InterruptedError.prototype.resume = 5000;

// --- Helpers ---

function getParent(item) {
  return item && item.data && item.data.parentItem;
}

function hasChildren(item) {
  return item && item.meta && item.meta.numChildren;
}


// --- Exports ---
Synchronizer.Session          = Session;
Synchronizer.InterruptedError = InterruptedError;

module.exports = Synchronizer;
