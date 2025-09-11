Yet another boilerplate free schema validation library, Connect/Express
middleware included.

    {validate, any, optional} = require 'schematron'

    schema = {
      key: any
      count: Number
      isActive: Boolean
      name: optional(String)
    }

    data = {
      key: {}
      count: 2
      isActive: false
    }

    {errors, data} = validate(schema, data)

Or use Connect/Express middleware

    {validate} = require 'schematron/middleware'

    app.get '/search',
      validate(q: String, limit: optional(Number)),
      (req, res) ->
        // access req.validQuery for validated data
