{extend, isObject, isNumber, isString, contains,
  isArray, isBoolean, isDate} = require 'underscore'

class type
  constructor: (params) ->
    if not (this instanceof type)
      return new type(params)
    extend this, params

  validate: (data) ->
    errors = "invalid data"
    {errors, data}

class any
  constructor: ->
    if not (this instanceof any)
      return new any

class optional
  constructor: (schema, defaultValue) ->
    if not (this instanceof optional)
      return new optional(schema, defaultValue)
    this.schema = schema
    this.defaultValue = defaultValue

class either extends type
  constructor: (a, b) ->
    if not (this instanceof either)
      return new either(a, b)
    this.a = a
    this.b = b

  validate: (data, options) ->
    tryB = {}
    tryA = validate(this.a, data, options)
    if tryA.errors
      tryB = validate(this.b, data, options)
    if tryB.errors
      errors = [tryA.errors, tryB.errors]
    return {errors, data: tryA.data or tryB.data}

validate = (schema, data, options = {}) ->
  errors = undefined

  if data is undefined
    if schema instanceof optional
      data = schema.defaultValue
    else
      errors = "missing value"
    return {errors, data}

  if schema instanceof type
    return schema.validate(data, options)

  if schema instanceof any or schema is any
    return {errors, data}

  if schema instanceof optional
    schema = schema.schema

  if schema is Number
      data = Number(data) if options.weak
      if not isNumber data or isNaN(data)
        errors = "should be a number"

  else if schema is String
    if not isString data
      errors = "should be a string"

  else if schema is Boolean
    if options.weak
      data = if isBoolean data
        data
      else if contains(['true', '1', 'yes'], data.toLowerCase())
        true
      else if contains(['false', '0', 'no'], data.toLowerCase())
        false
      else
        undefined
    if not isBoolean data
      errors = "should be a boolean"

  else if schema is Date
    data = new Date(data) if options.weak
    if not isDate data or isNaN(data.getDate())
      errors = "should be a date"

  else if isArray schema
    if not isArray data
      errors = "should be an array"
    else
      newData = for x, idx in data
        tryX = validate(schema[0], x, options)
        if tryX.errors
          errors = errors or {}
          errors[idx] = tryX.errors
        tryX.data

      return {errors, data: newData}
  else

    if not isObject data
      errors = "should be an object"
    else
      newData = {}
      for idx, subSchema of schema 
        tryX = validate(subSchema, data[idx], options)
        if tryX.errors
          errors = errors or {}
          errors[idx] = tryX.errors
        newData[idx] = tryX.data
      return {errors, data: newData}

  {errors, data}

module.exports = {validate, type, optional, either, any}
