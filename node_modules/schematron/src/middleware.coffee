{contains, isEmpty} = require 'underscore'
schematron = require './index'

validateBody = (schema) ->
  (req, res, next) ->
    {errors, data} = schematron.validate(schema, req.body)
    if not isEmpty errors
      res.send 400, errors
    else
      req.validBody = data
      next()

validateQuery = (schema) ->
  (req, res, next) ->
    {errors, data} = schematron.validate(schema, req.query, weak: true)
    if not isEmpty errors
      res.send 400, errors
    else
      req.validQuery = data
      next()

validate = (schema) ->
  (req, res, next) ->
    if contains(['GET', 'HEAD', 'OPTIONS'], req.method)
      validateQuery(schema)(req, res, next)
    else
      validateBody(schema)(req, res, next)

module.exports = {validateBody, validateQuery, validate}
