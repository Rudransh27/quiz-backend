// src/utils/moduleDepartments.js
// Shared helpers for checking a Module's (now multi-valued) `departments`
// array against an acting user's own department — replaces the repeated
// singular-equality pattern (`getDepartmentIdString(module.department) !==
// userDeptStr`) that used to live independently in moduleRoutes.js and
// topicRoutes.js before `department` became `departments`.

const moduleDeptIds = (module) => {
  if (!module || !Array.isArray(module.departments)) return [];
  return module.departments
    .map((d) => (d && d._id ? d._id : d))
    .filter(Boolean)
    .map((d) => d.toString());
};

const moduleHasDept = (module, deptId) => {
  if (!deptId) return false;
  return moduleDeptIds(module).includes(deptId.toString());
};

module.exports = { moduleDeptIds, moduleHasDept };
