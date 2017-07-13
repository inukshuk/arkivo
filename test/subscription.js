'use strict';

var sinon = require('sinon');
var chai = require('chai');
var expect = chai.expect;

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));

var B = require('bluebird');

var Subscription = require('../lib/subscription');
var defaults     = require('../lib/config').subscription;
var zotero       = require('../lib/zotero');

var db = require('../lib/db')(defaults.prefix);

function delayed() { return B.delay(0); }

describe('Subscription', function () {
  it('is a constructor function', function () {
    expect(Subscription).to.be.a('function');
  });

  it('has keys', function () {
    expect(Subscription).to.have.property('keys');
  });

  describe('constructor', function () {
    it('returns an empty subscription by default', function () {
      expect(new Subscription()).to.exist;
    });

    it('accepts an object or an array', function () {
      expect(new Subscription(['x'])).to.have.property('id', 'x');
      expect(new Subscription({ id: 'y' })).to.have.property('id', 'y');
    });
  });

  describe('#json', function () {
    it('returns an object', function () {
      expect((new Subscription()).json).to.be.an('object');
    });

    it('contains empty keys', function () {
      expect((new Subscription()).json).to.not.be.empty;
    });
  });

  describe('#touch', function () {
    it('updates the timestamp', function (done) {
      var a, s = new Subscription();

      expect(s.timestamp).to.equal(0);

      s.touch();
      a = s.timestamp;

      expect(a).to.be.a('string');

      // just to ensure some time elapsed!
      setTimeout(function () {
        expect(a).to.be.below(s.touch().timestamp);
        done();
      }, 15);
    });
  });

  describe('#reset', function () {
    it('resets version and versions', function () {
      var s = new Subscription();

      expect(s.reset.bind(s)).to.not.throw();

      s.version = 4;
      expect(s.reset().version).to.eql(0);

      s.versions = { foo: 3 };
      expect(s.reset().versions).to.be.empty;
    });
  });

  describe('#library', function () {
    it('returns the URLs library part', function () {
      var s = new Subscription();

      s.url = '/users/123/foo';
      expect(s.library).to.eql('/users/123');

      s.url = '/groups/1234/foo';
      expect(s.library).to.eql('/groups/1234');

      s.url = '/users/12345/publications';
      expect(s.library).to.eql('/users/12345/publications');

      s.url = '/users/123/publications/items';
      expect(s.library).to.eql('/users/123/publications');
    });
  });

  describe('#version', function () {
    it('is zero by default', function () {
      expect((new Subscription()).version).to.equal(0);
    });

    it('is stored as an integer', function () {
      var s = new Subscription();

      s.version = 3;
      expect(s.version).to.equal(3);

      s.version = '42';
      expect(s.version).to.equal(42);

      s.version = 'foo';
      expect(s.version).to.equal(0);
    });
  });

  describe('#header', function () {
    it('returns an empty object by default', function () {
      expect((new Subscription()).headers).to.be.empty;
    });

    it('includes authorization key', function () {
      expect((new Subscription({ key: 'XYZ' })).headers)
        .to.have.property('Authorization', 'Bearer XYZ');
    });

    it('includes if-modified-since-version', function () {
      expect((new Subscription({ version: 23 })).headers)
        .to.have.property('If-Modified-Since-Version', 23);
    });
  });

  describe('#url', function () {
    var s;

    beforeEach(function () { s = new Subscription(); });

    it('is an empty string by default', function () {
      expect(s.url).to.equal('');
    });

    it('is composed of path and params', function () {
      expect(s.path).to.be.null;
      expect(s.params).to.be.empty;

      s.path = 'foo';
      expect(s.url).to.equal('foo');

      s.params.bar = 'baz';
      expect(s.url).to.equal('foo?bar=baz');
    });

    it('sets path and params automatically', function () {
      s.url = 'foo/bar?baz=true';

      expect(s.path).to.equal('foo/bar');
      expect(s.params).to.have.property('baz', 'true');

      s = new Subscription({ url: 'tra/la/la?debug=false' });

      expect(s.path).to.equal('tra/la/la');
      expect(s.params).to.have.property('debug', 'false');
    });
  });

  describe('id mapping', function () {
    var s;

    beforeEach(function () {
      s = new Subscription({ url: '/users/12345/publications' });
      sinon.stub(db, 'hset', delayed);
      sinon.stub(db, 'hget', delayed);
    });

    afterEach(function () {
      db.hset.restore();
      db.hget.restore();
    });

    describe('#lookup', function () {
      it('prefixes the key with library and plugin', function () {
        return s.lookup('sufia', 'ABC').then(function () {
          expect(db.hget).to.have.been.calledWith(
              'sufia:/users/12345/publications', 'ABC');
        });
      });
    });

    describe('#remember', function () {
      it('prefixes the key with library and plugin', function () {
        return s.remember('sufia', 'ABC', '123').then(function () {
          expect(db.hset).to.have.been.calledWith(
              'sufia:/users/12345/publications', 'ABC', '123');
        });
      });
    });
  });

  describe('.find', function () {
    describe('called without query', function () {
      beforeEach(function () {
        sinon.stub(Subscription, 'all', delayed);
      });

      afterEach(function () {
        Subscription.all.restore();
      });

      it('delegates to .all', function () {
        return Subscription.find()
          .then(function () { expect(Subscription.all).to.have.been.called; });
      });
    });


    describe('called with a query', function () {
      var ids = ['foo', 'bar', 'baz'];

      beforeEach(function () {
        sinon.stub(Subscription, 'load', function (id) {
          return delayed().then(function () {
            return new Subscription({ id: id });
          });
        });

        sinon.stub(Subscription, 'ids', function () {
          return delayed().then(function () { return ids; });
        });
      });

      afterEach(function () {
        Subscription.load.restore();
        Subscription.ids.restore();
      });

      describe('when there are no matches', function () {
        it('eventually returns empty list', function () {
          return expect(Subscription.find('x')).to.eventually.eql([]);
        });
      });

      it('loads all subscriptions ids beginning with the query', function () {
        return Subscription.find('ba')
          .tap(function () {
            expect(Subscription.load).to.have.been.calledWith('bar');
            expect(Subscription.load).to.have.been.calledWith('baz');
          })
          .tap(function (res) {
            expect(res.length).to.eql(2);
          });
      });

      it('supports comma separated lists', function () {
        return Subscription.find('z,ba,fo,xy')
          .tap(function () {
            expect(Subscription.load).to.have.been.calledWith('foo');
            expect(Subscription.load).to.have.been.calledWith('bar');
            expect(Subscription.load).to.have.been.calledWith('baz');
          })
          .tap(function (res) {
            expect(res.length).to.eql(3);
          });
      });

      it('loads all subscriptions ids matchting the pattern', function () {
        return Subscription.find(/^foo|z$/)
          .tap(function () {
            expect(Subscription.load).to.have.been.calledWith('foo');
            expect(Subscription.load).to.have.been.calledWith('baz');
          })
          .tap(function (res) {
            expect(res.length).to.eql(2);
          });
      });
    });
  });

  describe('.load', function () {
    afterEach(function () {
      db.hgetall.restore();
    });

    describe('for existing subscriptions', function () {
      beforeEach(function () {
        sinon.stub(db, 'hgetall', function () {
          return B.fulfilled({ id: 'foo', bar: 'baz' });
        });
      });

      it('returns a promise for the subscription', function () {
        return expect(Subscription.load('foo'))
          .to.be.instanceOf(B)
          .and.eventually.be.fulfilled
          .and.instanceOf(Subscription)
          .and.have.property('bar', 'baz');
      });
    });

    describe('for non-existing subscriptions', function () {
      beforeEach(function () {
        sinon.stub(db, 'hgetall', function () {
          return B.fulfilled({});
        });
      });

      it('fails if the subscription does not exist', function () {
        return expect(Subscription.load('foo'))
          .to.eventually.be.rejectedWith(/not found/i);
      });
    });
  });

  describe('#values', function () {
    it('returns the values for each key', function () {
      var s = new Subscription();

      expect(s.values).to.have.length(Subscription.keys.length);

      s[Subscription.keys[0]] = 'foo';
      expect(s.values[0]).to.eql('foo');
    });
  });

  describe('#serialize', function () {
    it('returns a zipped array of all keys and values', function () {
      var s = (new Subscription()).serialize();

      expect(s).to.be.an.instanceof(Array);
      expect(s).to.have.length(Subscription.keys.length * 2);

      expect(s[0]).to.equal(Subscription.keys[0]);
      expect(s[1]).to.equal(s[Subscription.keys[0]]);
    });
  });

  describe('persistence', function () {
    var t, exists;

    function chainspy() {
      return sinon.spy(function () { return this; });
    }

    beforeEach(function () {
      exists = false;

      t = {
        zadd: chainspy(),
        hmset: chainspy(),
        zrem: chainspy(),
        del: chainspy(),
        commit: B.fulfilled.bind(B)
      };

      sinon.stub(db, 'transaction', function () {
        return t;
      });

      sinon.stub(Subscription, 'exists', function () {
        return B.fulfilled(exists);
      });
    });

    afterEach(function () {
      db.transaction.restore();
      Subscription.exists.restore();
    });

    describe('#destroy', function () {
      beforeEach(function () {
        sinon.stub(zotero, 'delete', function () {
          return B.fulfilled();
        });
      });

      afterEach(function () {
        zotero.delete.restore();
      });

      it('returns the destroyed instance', function () {
        var s = new Subscription();
        return expect(s.destroy()).to.eventually.equal(s);
      });

      it('does not invalidate keys by default', function () {
        return (new Subscription({ key: 'zotero-api-key' }))
          .destroy()
          .then(function () {
            expect(zotero.delete).to.not.have.been.called;
          });
      });

      it('invalidates keys when passed invalidate option', function () {
        return (new Subscription({
          url: '/users/23/collections/XY/items',
          key: 'zotero-api-key'
        }))

          .destroy({ 'invalidate-key': true })

          .then(function () {
            expect(zotero.delete).to.have.been.called;

            expect(zotero.delete.args[0][0])
              .to.eql('/users/23/keys/zotero-api-key');
          });
      });

      it('removes id and contents', function () {
        return (new Subscription({ id: 'myid' }))
          .destroy()
          .then(function () {
            expect(t.zrem.args[0][0]).to.eql('ids');
            expect(t.zrem.args[0][1]).to.eql('myid');
            expect(t.del.args[0][0]).to.eql('myid');
          });
      });
    });

    describe('#save', function () {
      it('returns a promise for the saved subscription', function () {
        var s = new Subscription({ url: 'users/123' });

        return expect(s.save())
          .to.eventually.be.fulfilled
          .and.equal(s)
          .and.have.property('url', 'users/123');
      });

      it('saves all keys', function () {
        var s = new Subscription();

        s.path = '/users/123';
        s.params.bar = 'baz';
        s.key = '42';

        return s.save()
          .then(function () {
            expect(t.hmset).to.have.been.calledOnce;

            var call = t.hmset.getCall(0);

            expect(call.args).to.have.length(2);
            expect(call.args[1]).to.have.length(Subscription.keys.length * 2);
            expect(call.args[0]).to.equal(call.args[1][1]);
            expect(call.args[1].slice(2, 8)).to.eql([
              'url', '/users/123?bar=baz', 'key', '42', 'version', 0
            ]);
          });
      });

      describe('for new subscriptions', function () {
        it('generates a new id', function () {
          var s = new Subscription({ url: '/groups/42' });

          return expect(s.save())
            .to.eventually.be.fulfilled
            .and.equal(s)
            .and.have.property('id')
            .and.match(/^[\da-z]{10}$/);
        });
      });

      describe('for existing subscriptions', function () {
        beforeEach(function () { exists = true; });

        it('does not alter the id', function () {
          var s = new Subscription({ id: 'foo', url: '/groups/2' });

          return expect(s.save())
            .to.eventually.be.fulfilled
            .and.have.property('id', 'foo');
        });
      });
    });
  });

  describe('#identify', function () {
    var COLLISIONS = 2;

    beforeEach(function () {
      var called = 0;

      sinon.stub(db, 'zscore', function () {
        return B.fulfilled().then(function () {
          return (called++ < COLLISIONS) ? 0 : null;
        });
      });
    });

    afterEach(function () {
      db.zscore.restore();
    });

    it('returns a promise for the subscription with an id', function () {
      var s = new Subscription();

      expect(s).to.not.have.property('id');
      return expect(s.identify()).eventually.to.equal(s)
        .and.to.have.property('id').and.to.have.length(10);
    });

    it('sets a unique id', function () {
      return (new Subscription()).identify().then(function () {
        expect(db.zscore.callCount).to.equal(COLLISIONS + 1);
      });
    });

    it('fails if subscription already has id', function () {
      var s = new Subscription({ id: 'foo' });
      return expect(s.identify()).to.eventually.be.rejected;
    });
  });

  describe('range loading', function () {
    var ids;

    beforeEach(function () {
      ids = ['foo', 'bar', 'baz'];

      sinon.stub(db, 'zcard', function () {
        return B.fulfilled(ids.length);
      });

      sinon.stub(db, 'zrange', function () {
        return B.fulfilled(ids);
      });

      sinon.stub(Subscription, 'load', function () {
        return B.fulfilled(new Subscription());
      });
    });

    afterEach(function () {
      db.zrange.restore();
      db.zcard.restore();
      Subscription.load.restore();
    });

    describe('.ids', function () {
      it('loads all subscription ids', function () {
        return Subscription.ids().then(function (s) {
          expect(s).to.have.length(3);
          expect(s).to.be.instanceof(Array);
          expect(s).to.have.property('range');
        });
      });
    });

    describe('.all', function () {
      it('loads all subscriptions', function () {
        return Subscription.all().then(function (s) {
          expect(s).to.have.length(3);
          expect(s[0]).to.be.instanceof(Subscription);
          expect(Subscription.load).to.have.been.calledTrice;

          expect(s).to.have.property('range');
          expect(Subscription.load).to.have.been.calledWith('foo');
          expect(Subscription.load).to.have.been.calledWith('bar');
          expect(Subscription.load).to.have.been.calledWith('baz');
        });
      });
    });
  });
});
