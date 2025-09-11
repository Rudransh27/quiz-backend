{ok, equal, deepEqual, notDeepEqual} = require 'assert'
{validate, any, either, optional} = require './src/index'

describe 'schema validation', ->

  assertValid = ({schema, data}) ->
    v = validate(schema, data)
    deepEqual v.errors, undefined
    deepEqual v.data, data

  assertInvalid = ({schema, data, errors}) ->
    v = validate(schema, data)
    deepEqual v.errors, errors

  it 'validates number', ->
    assertValid schema: Number, data: 1
    assertInvalid schema: Number, data: '1', errors: "should be a number"

  it 'validates string', ->
    assertValid schema: String, data: '1'
    assertInvalid schema: String, data: 1, errors: "should be a string"

  it 'validates boolean', ->
    assertValid schema: Boolean, data: true
    assertInvalid schema: Boolean, data: 'true', errors: "should be a boolean"

  describe 'array validation', ->

    it 'validates array', ->
      assertValid schema: [Number], data: [1, 2]
      assertInvalid schema: [Number], data: ['true'], errors: {"0": "should be a number"}
      assertInvalid schema: [Number], data: [1, 'true'], errors: {"1": "should be a number"}

    it 'validates empty array', ->
      assertValid schema: [Number], data: []
      assertValid schema: [String], data: []

  describe 'object validation', ->

    it 'validates object', ->
      schema = {k: Number}
      assertValid schema: schema, data: {k: 1}
      assertInvalid schema: schema, data: {k: true}, errors: {"k": "should be a number"}

    it 'validates object with optional keys', ->
      schema = {k: Number, ko: optional(Number)}
      assertValid schema: schema, data: {k: 1, ko: undefined}
      assertValid schema: schema, data: {k: 1, ko: 2}
      assertInvalid schema: schema, data: {k: 1, ko: '2'}, errors: {"ko": "should be a number"}

  it 'validates either', ->
    schema = either(Number, String)
    assertValid schema: schema, data: 1
    assertValid schema: schema, data: '1'
    assertInvalid schema: schema, data: true, errors: ["should be a number", "should be a string"]

  it 'validates any', ->
    schema = any
    assertValid schema: schema, data: 1
    assertValid schema: schema, data: '1'
    assertValid schema: schema, data: true
    assertValid schema: schema, data: []
    assertValid schema: schema, data: {}

describe 'weak schema validation', ->

  assertValid = ({schema, data, result}) ->
    result = if result is undefined then data else result
    v = validate(schema, data, weak: true)
    deepEqual v.errors, undefined
    deepEqual v.data, result

  assertInvalid = ({schema, data, errors}) ->
    v = validate(schema, data, weak: true)
    deepEqual v.errors, errors

  it 'validates number', ->
    assertValid schema: Number, data: 1
    assertValid schema: Number, data: '1', result: 1
    assertInvalid schema: Number, data: 's', errors: "should be a number"

  it 'validates string', ->
    assertValid schema: String, data: '1'
    assertInvalid schema: String, data: 1, errors: "should be a string"

  it 'validates boolean', ->
    assertValid schema: Boolean, data: true
    assertValid schema: Boolean, data: 'true', result: true
    assertValid schema: Boolean, data: 'yes', result: true
    assertValid schema: Boolean, data: '1', result: true
    assertValid schema: Boolean, data: 'false', result: false
    assertValid schema: Boolean, data: 'no', result: false
    assertValid schema: Boolean, data: '0', result: false
    assertInvalid schema: Boolean, data: 'bool', errors: "should be a boolean"

  describe 'array validation', ->

    it 'validates array', ->
      assertValid schema: [Number], data: [1, 2]
      assertInvalid schema: [Number], data: ['true'], errors: {"0": "should be a number"}
      assertInvalid schema: [Number], data: [1, 'true'], errors: {"1": "should be a number"}

    it 'validates empty array', ->
      assertValid schema: [Number], data: []
      assertValid schema: [String], data: []

  describe 'object validation', ->

    it 'validates object', ->
      schema = {k: Number}
      assertValid schema: schema, data: {k: 1}
      assertValid schema: schema, data: {k: '1'}
      assertInvalid schema: schema, data: {k: 's'}, errors: {"k": "should be a number"}

    it 'validates object with optional keys', ->
      schema = {k: Number, ko: optional(Number)}
      assertValid schema: schema, data: {k: 1, ko: undefined}
      assertValid schema: schema, data: {k: 1, ko: 2}
      assertValid schema: schema, data: {k: '1', ko: '2'}
      assertInvalid schema: schema, data: {k: 1, ko: 'x'}, errors: {"ko": "should be a number"}

  it 'validates either', ->
    schema = either(Number, String)
    assertValid schema: schema, data: 1, result: 1
    assertValid schema: schema, data: '1', result: 1
    assertValid schema: schema, data: true, result: 1
    assertInvalid schema: schema, data: {}, errors: ["should be a number", "should be a string"]

  it 'validates any', ->
    schema = any
    assertValid schema: schema, data: 1
    assertValid schema: schema, data: '1'
    assertValid schema: schema, data: true
    assertValid schema: schema, data: []
    assertValid schema: schema, data: {}

describe 'middleware', ->

  express = require 'express'
  request = require 'supertest'

  middleware = require './src/middleware'


  app = express()
  app.use express.bodyParser()

  app.get '/valid',
    middleware.validate(x: Number, y: String),
    (req, res) ->
      deepEqual req.validQuery, {x: 1, y: '2'}
      res.send 200

  app.post '/valid',
    middleware.validate(x: Number, y: String),
    (req, res) ->
      deepEqual req.validBody, {x: 1, y: '2'}
      res.send 200

  describe 'query string validation', ->

    it 'validates query string', (done) ->
      request(app)
        .get('/valid')
        .query(x: 1, y: '2')
        .expect(200, (x) -> done())

    it 'returns 400 on invalid data', (done) ->
      request(app)
        .get('/valid')
        .query(x: 1)
        .expect(400, done)

  describe 'body validation', ->

    it 'validates body', (done) ->
      request(app)
        .post('/valid')
        .send(x: 1, y: '2')
        .expect(200, done)

    it 'returns 400 on invalid data', (done) ->
      request(app)
        .post('/valid')
        .expect(400, done)
