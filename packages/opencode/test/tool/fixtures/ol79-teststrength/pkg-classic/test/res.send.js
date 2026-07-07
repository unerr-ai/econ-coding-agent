var assert = require('node:assert')

describe('res', function () {
  describe('.send(body)', function () {
    it('should send a string', function () {
      var out = res.send('hello')
      assert.ok(out)
    })
  })
})
