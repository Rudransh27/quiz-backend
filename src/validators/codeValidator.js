// src/validators/codeValidator.js

const { DOMParser } = require('xmldom');
// The xpath library is no longer needed.
// import xpath from 'xpath';

const parser = new DOMParser();

// This function remains the same and will be used by all validators.
function checkParserErrors(xmlDoc) {
  const errors = xmlDoc.getElementsByTagName("parsererror");
  if (errors.length > 0) {
    return {
      isCorrect: false,
      error: "❌ Invalid XML format. Please ensure your syntax is correct and well-formed."
    };
  }
  return null;
}

// The nsResolver is no longer needed since we are using regex.
// const nsResolver = (prefix) => {
//   const ns = {
//     'link': "http://www.xbrl.org/2003/linkbase",
//     'xlink': "http://www.w3.org/1999/xlink",
//     'ex': "http://example.com/taxonomy",
//     'xbrli': "http://www.xbrl.org/2003/instance",
//     'xbrldi': "http://xbrl.org/2006/xbrldi"
//   };
//   return ns[prefix] || null;
// };

// === Regex-based Validators ===

// Function to validate unitRef attribute
module.exports = function validateUnitRefAnswer(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const match = userInput.match(/unitRef\s*=\s*"([^"]+)"/i);
  if (!match) {
    return {
      isCorrect: false,
      error: "❌ No unitRef attribute found in your answer.",
    };
  }
  const unitRef = match[1].trim();
  if (unitRef.toLowerCase() !== "u1") {
    return {
      isCorrect: false,
      error: `❌ unitRef="${unitRef}" should be exactly "u1".`,
    };
  }
  return { isCorrect: true, error: null };
}

// Function to validate contextRef attribute
module.exports = function validateContextRefAnswer(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const match = userInput.match(/contextRef\s*=\s*"([^"]+)"/i);
  if (!match) {
    return {
      isCorrect: false,
      error: "❌ No contextRef attribute found in your answer.",
    };
  }
  const contextRef = match[1].trim();
  if (contextRef !== "C1") {
    return {
      isCorrect: false,
      error: `❌ contextRef="${contextRef}" must exactly match "C1" (case-sensitive).`,
    };
  }
  return { isCorrect: true, error: null };
}

// Function to validate a date range
module.exports = function validateDateRangeAnswer(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const startMatch = userInput.match(/<xbrli:startDate>(.*?)<\/xbrli:startDate>/);
  const endMatch = userInput.match(/<xbrli:endDate>(.*?)<\/xbrli:endDate>/);

  if (!startMatch || !endMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing <xbrli:startDate> or <xbrli:endDate> element.",
    };
  }

  const startDate = new Date(startMatch[1]);
  const endDate = new Date(endMatch[1]);

  if (isNaN(startDate.getTime())) {
    return {
      isCorrect: false,
      error: "❌ <xbrli:startDate> is not a valid date.",
    };
  }

  if (isNaN(endDate.getTime())) {
    return {
      isCorrect: false,
      error: "❌ <xbrli:endDate> is not a valid date.",
    };
  }

  if (startDate >= endDate) {
    return {
      isCorrect: false,
      error: "❌ startDate must be before endDate.",
    };
  }

  return { isCorrect: true, error: null };
}

// Function to validate currency code
module.exports = function validateCurrencyCodeAnswer(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const validCodes = ["USD", "EUR", "INR", "JPY"];
  const match = userInput.match(/<xbrli:measure>(.*?)<\/xbrli:measure>/);
  if (!match) {
    return {
      isCorrect: false,
      error: "❌ No <xbrli:measure> element found.",
    };
  }
  const code = match[1].replace(/^iso4217:/, "").toUpperCase();
  if (!validCodes.includes(code)) {
    return {
      isCorrect: false,
      error: `❌ Currency code "${code}" is invalid. Use one of: ${validCodes.join(", ")}.`,
    };
  }
  return { isCorrect: true, error: null };
}

// Function to validate revenue value
module.exports = function validateRevenueValueAnswer(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const match = userInput.match(/>(-?\d+)<\//);
  if (!match) {
    return {
      isCorrect: false,
      error: "❌ Could not find numeric value of Revenue.",
    };
  }
  const value = Number(match[1]);
  if (isNaN(value)) {
    return {
      isCorrect: false,
      error: "❌ Revenue value is not a valid number.",
    };
  }
  if (value < 0) {
    return {
      isCorrect: false,
      error: "❌ Revenue value must be greater than or equal to zero.",
    };
  }
  return { isCorrect: true, error: null };
}

// Function to validate a complete snippet of XML
module.exports = function validateAllFixesAnswer(inputXml) {
  const xmlDoc = parser.parseFromString(inputXml, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const startDateMatch = inputXml.match(/<xbrli:startDate>(.*?)<\/xbrli:startDate>/);
  const endDateMatch = inputXml.match(/<xbrli:endDate>(.*?)<\/xbrli:endDate>/);
  const measureMatch = inputXml.match(/<xbrli:measure>(.*?)<\/xbrli:measure>/);
  const revenueValueMatch = inputXml.match(/<ex:Revenue[^>]*>(-?\d+)<\/ex:Revenue>/);

  if (!startDateMatch || !endDateMatch) {
    return { isCorrect: false, error: "❌ Missing startDate or endDate element." };
  }
  const startDate = new Date(startDateMatch[1]);
  const endDate = new Date(endDateMatch[1]);
  if (!(startDate instanceof Date && !isNaN(startDate)) || !(endDate instanceof Date && !isNaN(endDate))) {
    return { isCorrect: false, error: "❌ Invalid date format in startDate or endDate." };
  }
  if (startDate >= endDate) {
    return { isCorrect: false, error: "❌ startDate must be before endDate." };
  }

  if (!measureMatch) {
    return { isCorrect: false, error: "❌ Missing measure element." };
  }
  const validCurrencies = ["USD", "EUR", "INR", "JPY"];
  const currencyCode = measureMatch[1].replace(/^iso4217:/i, "").toUpperCase();
  if (!validCurrencies.includes(currencyCode)) {
    return { isCorrect: false, error: `❌ Invalid currency code "${currencyCode}". Must be one of: ${validCurrencies.join(", ")}.` };
  }

  if (!revenueValueMatch) {
    return { isCorrect: false, error: "❌ Missing revenue value." };
  }
  const revenue = parseInt(revenueValueMatch[1], 10);
  if (isNaN(revenue)) {
    return { isCorrect: false, error: "❌ Revenue value is not a valid number." };
  }
  if (revenue < 0) {
    return { isCorrect: false, error: "❌ Revenue must be greater than or equal to zero." };
  }

  return { isCorrect: true, error: null };
}

// Function to validate Bushchat Hands-on snippet
module.exports = function validateBushchatHandsOnSnippet(xml) {
  const xmlDoc = parser.parseFromString(xml, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const instantMatch = xml.match(/<xbrli:instant>(.*?)<\/xbrli:instant>/);
  if (!instantMatch) {
    return { isCorrect: false, error: "❌ Missing <xbrli:instant> element." };
  }
  const instantDate = new Date(instantMatch[1]);
  if (isNaN(instantDate.getTime())) {
    return { isCorrect: false, error: "❌ <xbrli:instant> is not a valid date." };
  }

  const measureMatch = xml.match(/<xbrli:measure>(.*?)<\/xbrli:measure>/);
  if (!measureMatch) {
    return { isCorrect: false, error: "❌ Missing <xbrli:measure> element." };
  }
  if (!/^iso4217:[A-Z]{3}$/.test(measureMatch[1])) {
    return { isCorrect: false, error: "❌ Currency code must be upper-case ISO 4217 (e.g. USD, EUR)." };
  }

  const assetsMatch = xml.match(/<ex:Assets[^>]*decimals="([^"]+)"[^>]*>([\d\.,-]+)<\/ex:Assets>/);
  if (!assetsMatch) {
    return { isCorrect: false, error: "❌ <ex:Assets> element (with decimals) not found." };
  }
  const decimalsValue = assetsMatch[1];
  if (decimalsValue !== "INF" && isNaN(Number(decimalsValue))) {
    return { isCorrect: false, error: "❌ decimals should be an integer (e.g. 2 for 1000000.50) or INF." };
  }
  const valueParts = assetsMatch[2].split(".");
  if ((valueParts.length === 2) && decimalsValue !== "INF" && valueParts[1].length !== parseInt(decimalsValue, 10)) {
    return { isCorrect: false, error: `❌ The decimals attribute should match the number of digits after the decimal point in the amount (${valueParts[1].length}).` };
  }

  const contextIds = Array.from(xml.matchAll(/<xbrli:context id="([^"]+)"/g)).map(m => m[1]);
  const contextRefs = Array.from(xml.matchAll(/contextRef="([^"]+)"/g)).map(m => m[1]);
  for (const ref of contextRefs) {
    if (!contextIds.includes(ref)) {
      return { isCorrect: false, error: `❌ contextRef "${ref}" does not refer to any defined context.` };
    }
  }

  return { isCorrect: true, error: null };
}

// Function to validate dimension usage
module.exports = function validateDimensionUsage(inputXml) {
  const xmlDoc = parser.parseFromString(inputXml, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const contextSegmentMatch = inputXml.match(/<xbrli:context[^>]*id="C1"[^>]*>([\s\S]*?)<\/xbrli:context>/i);
  if (!contextSegmentMatch) {
    return { isCorrect: false, error: "❌ Missing context with id='C1'." };
  }
  const contextContent = contextSegmentMatch[1];

  if (!/<xbrli:segment>/.test(contextContent) || !/<\/xbrli:segment>/.test(contextContent)) {
    return { isCorrect: false, error: "❌ Context 'C1' must include a <xbrli:segment> element." };
  }

  const explicitMemberMatch = contextContent.match(/<xbrldi:explicitMember\s+dimension="([^"]+)">([^<]+)<\/xbrldi:explicitMember>/i);
  if (!explicitMemberMatch) {
    return { isCorrect: false, error: "❌ Missing <xbrldi:explicitMember> inside the segment with dimension attribute." };
  }

  const dimension = explicitMemberMatch[1];
  const member = explicitMemberMatch[2];

  if (dimension !== "ex:RegionAxis") {
    return { isCorrect: false, error: `❌ The dimension attribute should be "ex:RegionAxis", found "${dimension}".` };
  }
  if (member !== "ex:AsiaMember") {
    return { isCorrect: false, error: `❌ The explicitMember value should be "ex:AsiaMember", found "${member}".` };
  }

  return { isCorrect: true, error: null };
}

// Function to validate calculation
module.exports = function validateCalculation(inputXml) {
  const xmlDoc = parser.parseFromString(inputXml, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  function extractFactValue(concept) {
    const regex = new RegExp(`<${concept}[^>]*contextRef="([^"]+)"[^>]*unitRef="([^"]+)"[^>]*decimals="[^"]*"[^>]*>([\\d.,-]+)<\\/${concept}>`, 'i');
    const match = inputXml.match(regex);
    if (!match) return null;
    const valueStr = match[3].replace(/,/g, '');
    const val = parseFloat(valueStr);
    return Number.isNaN(val) ? null : val;
  }

  const revenue = extractFactValue("ex:Revenue");
  const otherIncome = extractFactValue("ex:OtherIncome");
  const totalIncome = extractFactValue("ex:TotalIncome");

  if (revenue === null) return { isCorrect: false, error: "❌ Missing or invalid <ex:Revenue> fact." };
  if (otherIncome === null) return { isCorrect: false, error: "❌ Missing or invalid <ex:OtherIncome> fact." };
  if (totalIncome === null) return { isCorrect: false, error: "❌ Missing or invalid <ex:TotalIncome> fact." };

  const sum = revenue + otherIncome;

  if (Math.abs(sum - totalIncome) > 0.0001) {
    return { isCorrect: false, error: `❌ Calculation error: Revenue (${revenue}) + OtherIncome (${otherIncome}) != TotalIncome (${totalIncome}).` };
  }

  return { isCorrect: true, error: null };
}

// Function to validate dimension and calculation
module.exports = function validateDimensionAndCalculation(inputXml) {
  const xmlDoc = parser.parseFromString(inputXml, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const dimResult = validateDimensionUsage(inputXml);
  if (!dimResult.isCorrect) return dimResult;

  const calcResult = validateCalculation(inputXml);
  if (!calcResult.isCorrect) return calcResult;

  const decimalsMatches = [...inputXml.matchAll(/decimals="([^"]+)"/g)];
  for (const match of decimalsMatches) {
    const val = match[1];
    if (!/^(INF|[+-]?\d+)$/.test(val)) {
      return { isCorrect: false, error: `❌ Invalid decimals value "${val}". Must be integer or "INF".` };
    }
  }

  const measureMatch = inputXml.match(/<xbrli:measure>(iso4217:[A-Z]{3})<\/xbrli:measure>/i);
  if (!measureMatch) {
    return { isCorrect: false, error: "❌ Missing or invalid <xbrli:measure> with ISO4217 currency code." };
  }

  return { isCorrect: true, error: null };
}

// Function to validate beginner level XML snippet 1
module.exports = function validateBeginner1(instanceXmlString) {
  const xmlDoc = parser.parseFromString(instanceXmlString, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }

  const contextMatch = instanceXmlString.match(/<xbrli:context[^>]*id="Context_A"[^>]*>([\s\S]*?)<\/xbrli:context>/i);
  if (!contextMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing context with id='Context_A'."
    };
  }
  const contextContent = contextMatch[1];

  const explicitMemberMatch = contextContent.match(/<xbrldi:explicitMember\s+dimension="ex:ProductAxis"\s*>(ex:CarsMember|ex:BikesMember)<\/xbrldi:explicitMember>/i);
  if (!explicitMemberMatch) {
    return {
      isCorrect: false,
      error: "❌ The <xbrldi:explicitMember> is missing or incorrect. It must be in Context_A, have a dimension of 'ex:ProductAxis', and a member of 'ex:CarsMember' or 'ex:BikesMember'."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Correct! The dimension and member are properly used."
  };
}

// Function to validate beginner level XML snippet 2
module.exports = function validateBeginner2(instanceXmlString) {
  const xmlDoc = parser.parseFromString(instanceXmlString, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const contextMatch = instanceXmlString.match(/<xbrli:context[^>]*id="Context_B"[^>]*>([\s\S]*?)<\/xbrli:context>/i);
  if (!contextMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing context with id='Context_B'."
    };
  }
  const contextContent = contextMatch[1];

  const explicitMemberMatch = contextContent.match(/<xbrldi:explicitMember\s+dimension="ex:LocationAxis"\s*>(ex:NorthMember|ex:SouthMember)<\/xbrldi:explicitMember>/i);
  if (!explicitMemberMatch) {
    return {
      isCorrect: false,
      error: "❌ The <xbrldi:explicitMember> is missing or incorrect. It must be in Context_B, have a dimension of 'ex:LocationAxis', and a member of 'ex:NorthMember' or 'ex:SouthMember'."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Correct! The dimension and member are spelled correctly and match the taxonomy."
  };
}

// Function to validate intermediate level XML snippet 1
module.exports = function validateIntermediate1(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const explicitMemberRegex = /<xbrli:context>.*?<xbrli:entity>.*?<xbrli:segment>.*?<xbrldi:explicitMember\s+dimension="ex:RegionAxis"\s*>(ex:AsiaMember|ex:EuropeMember)<\/xbrldi:explicitMember>.*?<\/xbrli:segment>.*?<\/xbrli:entity>.*?<\/xbrli:context>/is;
  const explicitMemberMatch = userInput.match(explicitMemberRegex);

  if (!explicitMemberMatch) {
    return {
      isCorrect: false,
      error: "❌ The <xbrldi:explicitMember> is missing or incorrect. It must have a dimension of 'ex:RegionAxis' and a member value of 'ex:AsiaMember' or 'ex:EuropeMember'."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Correct! You have fixed both the dimension and the member name."
  };
}

// Function to validate intermediate level XML snippet 2
module.exports = function validateIntermediate2(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const typedMemberRegex = /<xbrli:context>.*?<xbrli:entity>.*?<xbrli:segment>.*?<xbrldi:typedMember\s+dimension="ex:ProductAxis">.*?<ex:product>(.*?)<\/ex:product>.*?<\/xbrldi:typedMember>.*?<\/xbrli:segment>.*?<\/xbrli:entity>.*?<\/xbrli:context>/is;
  const typedMemberMatch = userInput.match(typedMemberRegex);

  if (!typedMemberMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing or incorrect <xbrldi:typedMember>. It must be inside <xbrli:segment> and have dimension=\"ex:ProductAxis\"."
    };
  }

  const productValue = typedMemberMatch[1].trim();
  if (!productValue) {
    return {
      isCorrect: false,
      error: "❌ <ex:product> should not be empty. Please provide a product value."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Well done! Your typed dimension is correctly defined."
  };
}

// Function to validate advanced level XML snippet 1
module.exports = function validateAdvanced1(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }

  const regionInSegment = /<xbrli:segment>.*?<xbrldi:explicitMember\s+dimension="ex:RegionAxis">.*?<\/xbrli:segment>/is.test(userInput);
  const regionInScenario = /<xbrli:scenario>.*?<xbrldi:explicitMember\s+dimension="ex:RegionAxis">.*?<\/xbrli:scenario>/is.test(userInput);
  const productInSegment = /<xbrli:segment>.*?<xbrldi:explicitMember\s+dimension="ex:ProductAxis">.*?<\/xbrli:segment>/is.test(userInput);
  const productInScenario = /<xbrli:scenario>.*?<xbrldi:explicitMember\s+dimension="ex:ProductAxis">.*?<\/xbrli:scenario>/is.test(userInput);

  if (!regionInSegment || regionInScenario) {
    return {
      isCorrect: false,
      error: "❌ The <ex:RegionAxis> dimension must be defined in <xbrli:segment> and must not be in <xbrli:scenario>."
    };
  }

  if (!productInScenario || productInSegment) {
    return {
      isCorrect: false,
      error: "❌ The <ex:ProductAxis> dimension must be defined in <xbrli:scenario> and must not be in <xbrli:segment>."
    };
  }

  const explicitMembers = [...userInput.matchAll(/<xbrldi:explicitMember\s+dimension="([^"]+)">([^<]+)<\/xbrldi:explicitMember>/gi)];
  const seenDimensions = new Set();
  const validDimensions = new Set(["ex:RegionAxis", "ex:ProductAxis"]);
  const validMembers = new Set(["ex:AsiaMember", "ex:EuropeMember", "ex:ElectronicsMember", "ex:FurnitureMember"]);

  for (const match of explicitMembers) {
    const dim = match[1];
    const val = match[2];
    if (!validDimensions.has(dim)) { return { isCorrect: false, error: `❌ Invalid dimension "${dim}".` }; }
    if (!validMembers.has(val)) { return { isCorrect: false, error: `❌ Invalid member "${val}".` }; }
    if (seenDimensions.has(dim)) { return { isCorrect: false, error: `❌ Dimension "${dim}" is used more than once.` }; }
    seenDimensions.add(dim);
  }

  return {
    isCorrect: true,
    error: "✅ Great job! Your dimensions are uniquely and correctly placed."
  };
}

// Function to validate label part 1
module.exports = function validateLabelPart1(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const labelRegex = /<link:label[^>]*xlink:type="resource"[^>]*xlink:role="http:\/\/www\.xbrl\.org\/2003\/role\/terseLabel"[^>]*xlink:label="([^"]+)"[^>]*>Revenue<\/link:label>/is;
  const labelMatch = userInput.match(labelRegex);

  if (!labelMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing or incorrect <link:label> element. Please check its type, role, and text content."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Great job! You've correctly defined the terse label."
  };
}

// Function to validate label part 2
module.exports = function validateLabelPart2(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const arcRegex = /<link:labelArc[^>]*xlink:from="loc_revenue"[^>]*xlink:to="lab_revenue_terse"[^>]*xlink:arcrole="http:\/\/www\.xbrl\.org\/2003\/arcrole\/concept-label"[^>]*xlink:type="arc"[^>]*\/>/is;
  const arcMatch = userInput.match(arcRegex);

  if (!arcMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing or incorrect <link:labelArc> element. Please check all attributes."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Well done! The <link:labelArc> connects your concept and label correctly."
  };
}

// Function to validate presentation part 1
module.exports = function validatePresentationPart1(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const arcRegex = /<link:presentationArc[^>]*xlink:from="loc_TotalOperatingExpenses"[^>]*xlink:to="loc_SalariesAndWages"[^>]*xlink:arcrole="http:\/\/www\.xbrl\.org\/2003\/arcrole\/parent-child"[^>]*xlink:type="arc"[^>]*order="10"[^>]*\/>/is;
  const arcMatch = userInput.match(arcRegex);

  if (!arcMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing or incorrect <link:presentationArc> element. Please check all attributes and their values."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Well done! The <link:presentationArc> correctly links the parent and child concepts."
  };
}

// Function to validate presentation part 2
module.exports = function validatePresentationPart2(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const salariesArcRegex = /<link:presentationArc[^>]*xlink:from="loc_TotalOperatingExpenses"[^>]*xlink:to="loc_SalariesAndWages"[^>]*xlink:arcrole="http:\/\/www\.xbrl\.org\/2003\/arcrole\/parent-child"[^>]*xlink:type="arc"[^>]*order="10"[^>]*\/>/is;
  const rentArcRegex = /<link:presentationArc[^>]*xlink:from="loc_TotalOperatingExpenses"[^>]*xlink:to="loc_RentExpense"[^>]*xlink:arcrole="http:\/\/www\.xbrl\.org\/2003\/arcrole\/parent-child"[^>]*xlink:type="arc"[^>]*order="(?:[2-9]\d|\d{2,})"[^>]*\/>/is;

  const salariesArcMatch = userInput.match(salariesArcRegex);
  const rentArcMatch = userInput.match(rentArcRegex);

  if (!salariesArcMatch) {
    return {
      isCorrect: false,
      error: "❌ The arc for 'SalariesAndWages' is missing or incorrect. Please ensure it's present as expected."
    };
  }

  if (!rentArcMatch) {
    return {
      isCorrect: false,
      error: "❌ The arc for 'RentExpense' is missing or incorrect. It must have an 'order' greater than 10."
    };
  }
  const allArcs = userInput.match(/<link:presentationArc/g);
  if (allArcs && allArcs.length !== 2) {
    return {
      isCorrect: false,
      error: `❌ Incorrect number of <link:presentationArc> elements found (${allArcs.length}). You should have exactly two arcs.`
    };
  }

  return {
    isCorrect: true,
    error: "✅ Fantastic! You have successfully added 'RentExpense' and correctly ordered it under 'TotalOperatingExpenses'."
  };
}

// Function to validate calculation part 1
module.exports = function validateCalculationPart1(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const arcRegex = /<link:calculationArc[^>]*xlink:from="loc_NetIncome"[^>]*xlink:to="loc_Revenue"[^>]*xlink:arcrole="http:\/\/www\.xbrl\.org\/2003\/arcrole\/summation-item"[^>]*xlink:type="arc"[^>]*weight="1"[^>]*\/>/is;
  const arcMatch = userInput.match(arcRegex);

  if (!arcMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing or incorrect <link:calculationArc>. Please check all attributes."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Great job! Your <link:calculationArc> correctly links NetIncome to Revenue with weight 1."
  };
}

// Function to validate calculation part 2
module.exports = function validateCalculationPart2(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const arcCount = (userInput.match(/<link:calculationArc/g) || []).length;
  if (arcCount < 2) {
    return {
      isCorrect: false,
      error: "❌ It looks like you're missing the second <link:calculationArc> element for CostOfGoodsSold."
    };
  }
  const secondArcRegex = /<link:calculationArc[^>]*xlink:from="loc_NetIncome"[^>]*xlink:to="loc_CostOfGoodsSold"[^>]*xlink:arcrole="http:\/\/www\.xbrl\.org\/2003\/arcrole\/summation-item"[^>]*xlink:type="arc"[^>]*weight="-1"[^>]*\/>/is;
  const secondArcMatch = userInput.match(secondArcRegex);

  if (!secondArcMatch) {
    return {
      isCorrect: false,
      error: "❌ Your second <link:calculationArc> must link from 'loc_NetIncome' to 'loc_CostOfGoodsSold' with weight=\"-1\"."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Well done! You've correctly added the subtraction arc for CostOfGoodsSold."
  };
}

// Function to validate definition domain member
module.exports = function validateDefinitionDomainMember(userInput) {
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }
  const arcRegex = /<link:definitionArc[^>]*xlink:from="loc_GeoRegionAxis"[^>]*xlink:to="loc_EuropeMember"[^>]*xlink:arcrole="http:\/\/xbrl\.org\/2005\/arcrole\/domain-member"[^>]*xlink:type="arc"[^>]*\/>/is;
  const arcMatch = userInput.match(arcRegex);

  if (!arcMatch) {
    return {
      isCorrect: false,
      error: "❌ Your <link:definitionArc> must link from 'loc_GeoRegionAxis' to 'loc_EuropeMember' with the correct arcrole and type."
    };
  }

  return {
    isCorrect: true,
    error: "✅ Great job! You correctly defined the domain-member relationship."
  };
}


module.exports = function validateReferencePart1(userInput) {
  // First, validate if the input is well-formed XML
  const xmlDoc = parser.parseFromString(userInput, "application/xml");
  const parserError = checkParserErrors(xmlDoc);
  if (parserError) {
    return parserError;
  }

  // Regex to match the complete <link:reference> resource
  const referenceRegex = /<link:reference[^>]*xlink:role="http:\/\/www\.xbrl\.org\/2003\/role\/reference"[^>]*xlink:type="resource"[^>]*xlink:label="([^"]+)"[^>]*>\s*<ref:Standard>IFRS 15<\/ref:Standard>\s*<ref:Paragraph>10<\/ref:Paragraph>\s*<\/link:reference>/is;
  const referenceMatch = userInput.match(referenceRegex);

  if (!referenceMatch) {
    return {
      isCorrect: false,
      error: "❌ Missing or incorrect <link:reference> element. Check the role, type, label, and content of <ref:Standard> and <ref:Paragraph>."
    };
  }

  // Extract the xlink:label from the matched reference to use in the next check
  const referenceLabel = referenceMatch[1];

  // Regex to match the <link:referenceArc> that links to the reference
  const arcRegex = new RegExp(`<link:referenceArc[^>]*xlink:from="loc_Revenue"[^>]*xlink:to="${referenceLabel}"[^>]*xlink:arcrole="http://www.xbrl.org/2003/arcrole/concept-reference"[^>]*xlink:type="arc"[^>]*\\/>`, 'is');
  const arcMatch = userInput.match(arcRegex);

  if (!arcMatch) {
    return {
      isCorrect: false,
      error: `❌ Missing or incorrect <link:referenceArc>. The 'xlink:from' attribute should be 'loc_Revenue', and the 'xlink:to' attribute should match the label you defined for your reference resource (${referenceLabel}).`
    };
  }

  // If both matches are successful, the solution is correct
  return {
    isCorrect: true,
    error: "✅ Excellent! The concept is now correctly linked to its reference."
  };
}