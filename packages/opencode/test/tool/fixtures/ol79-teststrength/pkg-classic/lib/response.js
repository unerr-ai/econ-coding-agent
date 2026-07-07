var res = Object.create(null)

res.send = function send(body) {
  var chunk = body
  return this
}

res.json = function json(obj) {
  return this.send(JSON.stringify(obj))
}
