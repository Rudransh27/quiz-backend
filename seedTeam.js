// src/scripts/seedIFile.js
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// 🧠 Adjust paths to point exactly to your actual schema configuration files
const Department = require('./src/models/Department');
const Team = require('./src/models/Team');
const Module = require('./src/models/Module');

dotenv.config();

const seedTeam = async () => {
  try {
    console.log('📡 Connecting to cluster instance machine streams...');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/xbrl_app');
    console.log('✅ Connection established.');

    // 🏢 1. FIND OR CREATE THE IFILE DEPARTMENT NODE
    let ifileDept = await Department.findOne({ code: 'ifile' });
    if (!ifileDept) {
      ifileDept = new Department({
        name: 'iFile',
        code: 'ifile',
        description: 'IRIS Core iFile Systems Operations and Management Framework.'
      });
      await ifileDept.save();
      console.log('🏢 Created fresh iFile Department asset mapping.');
    }

    // 👥 2. ADD SUB-TEAMS INSIDE THE DEPARTMENT
    let devOpsTeam = await Team.findOne({ department_id: ifileDept._id, code: 'DEVOPS' });
    if (!devOpsTeam) {
      devOpsTeam = new Team({
        name: 'iFile DevOps',
        code: 'DEVOPS',
        department_id: ifileDept._id
      });
      await devOpsTeam.save();
      console.log('👥 Seeded: iFile DevOps Team Node.');
    }

    let devTeam = await Team.findOne({ department_id: ifileDept._id, code: 'DEVELOPERS' });
    if (!devTeam) {
      devTeam = new Team({
        name: 'iFile Developers',
        code: 'DEVELOPERS',
        department_id: ifileDept._id
      });
      await devTeam.save();
      console.log('👥 Seeded: iFile Developers Team Node.');
    }

    // 🧹 CLEAR OUT OLD DUMMY MODULES TO AVOID CLUTTER MULTIPLYING
    await Module.deleteMany({ title: { $regex: '\[TEST\]' } });

    // 📚 3. PROVISION TARGETED MODULES MATCHING YOUR VISIBILITY MATRIX
    const mockModules = [
      {
        title: '[TEST] Global Platform Onboarding',
        description: 'Universal platform architectural guidelines accessible across all business units.',
        visibility: 'Global',
        department: null,
        targetTeams: [],
        imageUrl: 'https://images.unsplash.com/photo-1434030216411-0b793f4b4173'
      },
      {
        title: '[TEST] iFile Department Protocols',
        description: 'Standard working instructions meant exclusively for all members within iFile.',
        visibility: 'Departmental',
        department: ifileDept._id,
        targetTeams: [],
        imageUrl: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40'
      },
      {
        title: '[TEST] iFile DevOps Jenkins Pipeline Core',
        description: 'Advanced automated integration instructions restricted explicitly to DevOps engineers.',
        visibility: 'Team-Specific',
        department: ifileDept._id,
        targetTeams: [devOpsTeam._id],
        imageUrl: 'https://images.unsplash.com/photo-1618401471353-b98aedd07871'
      }
    ];

    await Module.insertMany(mockModules);
    console.log('🚀 Successfully populated 3 test layers onto your cluster pipeline framework!');

  } catch (error) {
    console.error('❌ Critical failure running database target seeding operations:', error.message);
  } finally {
    mongoose.connection.close();
    console.log('🔌 Connection closed safely.');
  }
};

seedTeam();