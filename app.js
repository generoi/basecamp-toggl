var Basecamp = require('basecamp')
  , Toggl = require('toggl')
  , _ = require('underscore')
  , Backbone = require('backbone')
  , fs = require('fs')
  , config = require('./config')
  , app = {}
  , created_project = /created the project: (.*)/
  , created_todolist = /created a to-do list: (.*)/
  , client_project = /([^\-]+)\s+-\s+(.*)/
  , last_update = '2012-08-01T17:00:00+03:00'
  , CACHE_FILE = '/tmp/basecamp-toggl'
  , GENERO_WORKSPACE = { id : config.toggl_workspace };

// Preamble {{{1

_.extend(app, Backbone.Events, {
  toggl: {
    fetchingProjects : false
  }
});

Basecamp.init({
    username : config.bc_username
  , password : config.bc_password
  , account: config.bc_account
});

Toggl.init(config.toggl_key);

var togglClients = new Toggl.Clients();
var togglProjects = new Toggl.Projects();
var togglTasks = new Toggl.Tasks();


fs.readFile(CACHE_FILE, 'utf8', function (err, data) {
  last_update = err ? getTime() : data;
  fs.writeFile(CACHE_FILE, getTime());
  getBasecampEvents();
});

// }}}
// Helpers {{{1

var slice = Array.prototype.slice;

function getProjectName(name) {
  return ((client_project.exec(name) || [0,0,name])[2]).replace(/&amp;/, '&');
}
function getProjectClient(name) {
  return (client_project.exec(name) || [])[1];
}

function getTime() {
  function pad(number) {
    var r = String(number);
    if ( r.length === 1 ) {
      r = '0' + r;
    }
    return r;
  }

  var today = new Date();

  return today.getUTCFullYear() +
    '-' + pad( today.getUTCMonth() + 1 ) +
    '-' + pad( today.getUTCDate() ) +
    'T' + pad( today.getUTCHours() ) +
    ':' + pad( today.getUTCMinutes() ) +
    ':' + pad( today.getUTCSeconds() ) +
    '+00:00';
}

function defaultSuccess(obj, model, response) {
  if (response[0] === 'Name has already been taken') {
    console.log('Name has already been taken (' + obj.type + '): ' + obj.model.get('name'));
    app.trigger(obj.api + ':found-' + obj.type, obj.model);
  } else {
    model.id = response.data.id;
    app.trigger(obj.api + ':created-' + obj.type, model);
  }
  model.trigger('found');
}

// }}}

function getBasecampEvents(page) {
  page || (page = 1);

  var events = new Basecamp.Events()
    , todolist_name;

  events.on('reset', function() {
    events.forEach(function(event) {
      var summary = event.get('summary')
        , project = event.get('bucket')
        , tmp;

      if (created_project.exec(summary)) {
        project.client = getProjectClient(project.name);
        project.name = getProjectName(project.name);

        app.trigger('basecamp:new-project', project);
      }
      if ((todolist_name = (created_todolist.exec(summary) || [0, 0])[1])) {
        app.trigger('basecamp:new-todolist', { name : todolist_name, project: project });
      }
    });
    if (events.length === 50) getBasecampEvents(++page);
  });
  events.fetch({ data: { since: last_update, page : page } });
}

function createProject(name, client) {
  // On first call, request the projects list
  if (togglProjects.length === 0) {
    if (app.toggl.fetchingProjects) return;
    app.toggl.fetchingProjects = true;

    togglProjects.on('reset', function() {
      app.toggl.fetchingProjects = false;
      createProject(name, client);
    });
    togglProjects.fetch();
    return;
  }

  var fullname = (client) ? client + ' - ' + name : name
    , project = togglProjects.where({ client_project_name: fullname });

  // The project already exists
  if (project.length) {
    project = project[0];
    project.trigger('found');
    app.trigger('toggl:found-project', project);

  // Create the project and
  } else {
    project = new Toggl.Project({
        billable: true
      , name : name
      , workspace : GENERO_WORKSPACE
      , is_private : false
    });
    if (client) project.set({ client : { id: client.id } });

    project.save({}, { success: _.bind(defaultSuccess, this, { type : 'project', api: 'toggl', model: project }) });

    togglProjects.add(project);
  }
}

function createClient(name) {
  // On first call, request the projects list
  if (togglClients.length === 0) {
    if (app.toggl.fetchingClients) return;
    app.toggl.fetchingClients = true;

    togglClients.on('reset', function() {
      app.toggl.fetchingClients = false;
      createClient(name);
    });
    togglClients.fetch();
    return;
  }

  var client = togglClients.where({ name : name });

  if (client.length) {
    client = client[0];
    client.trigger('found');
    app.trigger('toggl:found-client', client);
  } else {
    client = new Toggl.Client({
        name: name
      , workspace: GENERO_WORKSPACE
    });

    client.save({}, { success: function(model, response) {
      model.id = response.data.id;
      model.trigger('found');
      app.trigger('toggl:created-client', client);
    }});

    togglClients.add(client);
  }
}

function createTodo(obj) {
  var project = togglProjects.where({ client_project_name: obj.project.name})
    , todo;

  if (project.length) {
    project = project[0];
    console.log('Adding: ', project.get('name'), obj.name);
    todo = new Toggl.Task({
        name : obj.name
      , project : { id: project.id }
      , is_active : true
    });
    todo.save({}, { success: _.bind(defaultSuccess, this, { type : 'task', api: 'toggl', model: todo }) });
  }
}

app.on('basecamp:new-project', function(obj) {
  if (typeof obj.client !== 'undefined') {
    app.on('toggl:found-client toggl:created-client', function(client) {
      createProject(obj.name, client);
    });
    createClient(obj.client);
  } else {
    createProject(obj.name);
  }
});

app.on('basecamp:new-todolist', function(obj) {
  var project = togglProjects.where({name: obj.project.name});

  if (project.length) {
    createTodo(obj);
  } else {
    app.on('toggl:found-project toggl:created-project', function(project) {
      var fullname = project.get('client').name + ' - ' + project.get('name');
      if (fullname === obj.project.name) createTodo(obj);
    });
    createProject(getProjectName(obj.project.name), getProjectClient(obj.project.name));
  }
});

app.on('toggl:created-project', function(project) {
  console.log('Created project: ' + project.get('name'));
});
app.on('toggl:created-client', function(client) {
  console.log('Created client: ' + client.get('name'));
});
app.on('toggl:created-task', function(task) {
  console.log('Created task: ' + task.get('name'));
});

function errFunc() {
  console.log('error');
  console.dir(arguments);
}
