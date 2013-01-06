var initTasks = function(api, next){

  /////////////////////
  // The task object //
  /////////////////////

  // required: name
  // optional: runAt, params, toAnnounce
  api.task = function(data){
    if(data == null){data = {}; }
    this.buildDefaults(data);
    this.validate();
    this.determineScope();
    this.determinePeriodic();
  }

  api.task.prototype.buildDefaults = function(data){
    this.name = data.name;
    this.id = this.generateID();
    var defaults = {
      name: null,
      id: this.generateID(),
      runAt: null,
      params: {},
      toAnnounce: true,
      queue: 'unknown',
      state: 'unknown',
    }
    for(var i in defaults){
      this[i] = defaults[i];
      if(data[i] != null){
        this[i] = data[i];
      }
    }
  }

  api.task.prototype.validate = function(){
    if(this.name === null){ throw new Error("name is required"); }
    if(api.tasks.tasks[this.name] == null){ throw new Error("task name not found"); }
  }

  api.task.prototype.generateID = function(){
    return api.utils.uuid() + ":" + api.id;
  }

  api.task.prototype.determineScope = function(){
    this.scope = api.tasks.tasks[this.name].scope;
  }

  api.task.prototype.determinePeriodic = function(){
    this.periodic = false;
    this.frequency = null;
    if(api.tasks.tasks[this.name].frequency > 0){
      this.periodic = true;
      this.frequency = api.tasks.tasks[this.name].frequency;
    }
  }

  api.task.prototype.determinePeriodicEnqueability = function(callback){
    var self = this;
    var toEnqueue = true;
    if(self.periodic == false){
      callback(toEnqueue);
    }else{
      api.tasks.getAllTasks(api, self.name, function(err, matchedTasks){
        if(self.scope === "any"){
          if(api.utils.hashLength(matchedTasks) > 0){ toEnqueue = false; }
          callback(toEnqueue);
        }else{
          for(var i in matchedTasks){
            if(matchedTasks[i].queue == api.tasks.queues.globalQueue){
              toEnqueue = false;
              break;
            }
          }
          callback(toEnqueue);
        }
      });
    }
  }
  
  api.task.prototype.enqueue = function(queue, callback){
    if(callback == null && typeof queue == 'funciton'){
      callback = queue;
      queue = null;
    }
    var self = this;
    self.determinePeriodicEnqueability(function(toEnqueue){
      if(toEnqueue){
        if(queue == null){
          queue = api.tasks.queues.globalQueue;
        }
        self.state = 'pending';
        if(self.runAt != null && self.runAt > new Date().getTime()){
          queue = api.tasks.queues.delayedQueue;
          self.state = 'delayed';
        }
        var data = {
          id: self.id, 
          name: self.name, 
          periodic: self.periodic, 
          frequency: self.frequency, 
          scope: self.scope, 
          params: self.params, 
          runAt: self.runAt, 
          toAnnounce: self.toAnnounce,
          enqueuedAt: new Date().getTime(),
          state: self.state,
          queue: queue,
        };
        api.tasks.setTaskData(api, self.id, data, function(error){
          api.tasks.placeInQueue(api, self.id, queue, function(){
            callback(null, true);
          });
        });
      }else{
        callback(null, new Error("not enquing as periodic task is already in the queue"));
      }
    })
  }

  api.task.prototype.duplicate = function(){
    var data = {};
    for(var i in this){
      if(typeof this[i] != "function"){
        data[i] = this[i];
      }
    }
    var newTask = new api.task(data);
    newTask.id = newTask.generateID();
    return newTask;
  }

  api.task.prototype.run = function(callback){
    var self = this;
    var params = self.params;
    if(api.domain != null){
      var taskDomain = api.domain.create();
      taskDomain.on("error", function(err){
        api.exceptionHandlers.task(taskDomain, err, api.tasks.tasks[taskName], callback);
      });
      taskDomain.run(function(){
        api.tasks.tasks[taskName].run(api, params, function(err, cont){
          if(cont == null){cont = true;}
          if(typeof callback == "function"){ callback(cont); }
        });
      })
    }else{
      api.tasks.tasks[taskName].run(api, params, function(err, cont){
        if(cont == null){cont = true;}
        if(typeof callback == "function"){ callback(cont); }
      });
    }
  }

  /////////////////////////
  // The task processors //
  /////////////////////////

  api.taskProcessor = function(data){
    if(data == null){data = {}; }
    this.buildDefaults(data);
  }

  api.taskProcessor.prototype.buildDefaults = function(data){
    if(data.id == null){ throw new Error("taskProcessors need an id"); }
    var defaults = {
      id: data.id,
      cycleTimeMS: api.tasks.cycleTimeMS,
      currentTask: null,
      timer: null,
      running: false
    }
    for(var i in defaults){
      this[i] = defaults[i];
      if(data[i] != null){
        this[i] = data[i];
      }
    }
  }

  api.taskProcessor.prototype.log = function(message){
    api.log("[taskProcessor "+this.id+"] " + message, "yellow");
  }

  api.taskProcessor.prototype.process = function(callback){
    var self = this;
    clearTimeout(self.timer);

    if(self.running){
      api.tasks.queueLength(api, api.tasks.queues.globalQueue, function(err, globalQueueCount){
        api.tasks.queueLength(api, api.tasks.queues.localQueue, function(err, localQueueCount){
          api.tasks.queueLength(api, api.tasks.queues.delayedQueue, function(err, delayedQueueCount){
            if(localQueueCount > 0){

              // work something from the local queue to processing, and work it off
              api.tasks.changeQueue(api, api.tasks.queues.localQueue, api.tasks.queues.processingQueue, function(err, task){
                if(task == null){
                  self.prepareNextRun();
                  if(typeof callback == "function"){ callback(); }
                }else{
                  self.currentTask = task;
                  self.log("starting task " + task.name);
                  task.run(function(){
                    api.tasks.removeFromQueue(api, task.id, api.tasks.queues.processingQueue, function(){
                      self.log("completed task " + task.name);
                      self.prepareNextRun();
                      if(typeof callback == "function"){ callback(); }
                    });
                  });
                }
              });
            }else if(globalQueueCount > 0){

              // move something from the global queue to the local queue (and distribute if needed)
              api.tasks.changeQueue(api, api.tasks.queues.localQueue, api.tasks.queues.processingQueue, function(err, task){
                if(task == null){
                  self.prepareNextRun();
                  if(typeof callback == "function"){ callback(); }
                }else{
                  self.currentTask = task;
                  self.log("preparing task " + task.name + " to run locally");
                  api.tasks.copyToReleventLocalQueues(api, task, function(){
                    self.prepareNextRun();
                    if(typeof callback == "function"){ callback(); }
                  });
                }
              });

            }else if(delayedQueueCount > 0){

              // move something from the delayed queue to the global queue if ready
              api.tasks.promoteFromDelayedQueue(api, function(err, task){
                self.currentTask = task;
                self.log("promoted delayed task " + promotedTask.name + " to the global queue");
                self.prepareNextRun();
                if(typeof callback == "function"){ callback(); }
              });

            }else{

              // nothing to do
              self.prepareNextRun();
              if(typeof callback == "function"){ callback(); }
            }

          });
        });
      });
    }else{
      if(typeof callback == "function"){ callback(); }
    }
  }

  api.taskProcessor.prototype.prepareNextRun = function(){
    var self = this;
    self.currentTask = null;
    self.timer = setTimeout(function(){
      self.process();
    }, self.cycleTimeMS);
  }

  api.taskProcessor.prototype.start = function(){
    this.running = true
    this.process();
  }

  api.taskProcessor.prototype.stop = function(){
    this.running = false;
    clearTimeout(this.timer);
  }

  //////////////////////////
  // The tasks themselves //
  //////////////////////////

  api.tasks = {};
  api.tasks.tasks = {};
  api.tasks.taskProcessors = [];
  api.tasks.cycleTimeMS = 200;

  if(api.redis.enable === true){
    api.tasks.queues = {
      globalQueue: 'actionHero:tasks:global',
      delayedQueue: 'actionHero:tasks:delayed',
      localQueue: 'actionHero:tasks:' + api.id,
      processingQueue: 'actionHero:tasks:processing',
      data: 'actionHero:tasks:data', // actually a hash
    }
  }else{
    api.tasks.queue = [];
  }

  api.tasks._start = function(api, next){
    var i = 0;
    api.log("starting "+api.configData.general.workers+" task timers", "yellow")
    while(i < api.configData.general.workers){
      var taskProcessor = new api.taskProcessor({id: i});
      taskProcessor.start();
      api.tasks.taskProcessors[i] = taskProcessor;
      i++;
    }
    next();
  }

  api.tasks._teardown = function(api, next){
    api.tasks.taskProcessors.forEach(function(taskProcessor){
      taskProcessor.stop();
    })
    next();
  }

  // wrapper for the old method of making tasks; this will be removed in future versions
  api.tasks.enqueue = function(api, taskName, runAtTime, params, next, toAnnounce){
    var Task = new api.task({name: taskName, runAt: runAtTime, params: params, toAnnounce: toAnnounce})
    Task.enqueue();
    process.nextTick(function(){ if(typeof next == 'function'){ next(); } });
  }

  api.tasks.getAllLocalQueues = function(api, callback){
    if(api.redis.enable === true){
      api.redis.client.lrange("actionHero:peers",0,-1,function(err,peers){
        var allLocalQueues = [];
        for(var i in peers){
          allLocalQueues.push("actionHero:tasks:" + peers[i]);
        }
        if(typeof next == "function"){ next(null, allLocalQueues); }
      });
    }else{

    }
  }

  api.tasks.copyToReleventLocalQueues = function(api, task, callback){
    if(api.redis.enable === true){
      api.tasks.getAllLocalQueues(function(err, allLocalQueues){
        var releventLocalQueues = []
        if(task.scope == "any"){
          // already moved
        }else{
          releventLocalQueues = allLocalQueues
        }
        if(releventLocalQueues.length == 0){
          if(typeof callback == "function"){ callback(); }
        }else{
          var started = 0;
          for(var i in releventLocalQueues){
            started++;
            var queue = releventLocalQueues[i];
            if(queue != api.tasks.queues.localQueue){
              var taskCopy = task.duplicate();
              taskCopy.enqueue(queue, function(){
                started--;
                if(started == 0){ if(typeof callback == "function"){ callback(); } }
              }); 
            }
          }
        }
      })
    }else{

    }
  }

  api.tasks.getAllTasks = function(api, nameToMatch, callback){
    if(callback == null && typeof matcher == "function"){
      callback = nameToMatch;
      nameToMatch = null;
    }
    if(api.redis.enable === true){
      api.redis.client.hgetall(api.tasks.queues.data, function(err, data){
        if(nameToMatch == null){
          if(typeof callback == "function"){ callback(err, data); }
        }else{
          var results = {};
          for(var i in data){
            if(data[i].name == nameToMatch){
              results[i] = data[i];
            }
          }
          if(typeof callback == "function"){ callback(err, results); }
        }
      });
    }else{

    }
  }

  api.tasks.setTaskData = function(api, taskId, data, callback){
    if(api.redis.enable === true){
      api.tasks.getTaskData(api, taskId, function(err, muxedData){
        for(var i in data){
          muxedData[i] = data[i];
        }
        api.redis.client.hset(api.tasks.queues.data, taskId, JSON.stringify(muxedData), function(err){
          if(typeof callback == "function"){ callback(err, muxedData); }
        });
      });
    }else{

    }
  }

  api.tasks.getTaskData = function(api, taskId, callback){
    if(api.redis.enable === true){
      api.redis.client.hget(api.tasks.queues.data, taskId, function(err, data){
        try{
          data = JSON.parse(data);
        }catch(e){ 
          data = {}; 
        }
        if(typeof callback == "function"){ callback(err, data); }
      });
    }else{

    }
  }

  api.tasks.clearTaskData = function(api, taskId, callback){
    if(api.redis.enable === true){
      api.redis.client.hdel(api.tasks.queues.data, taskId, function(err){
        if(typeof callback == "function"){ callback(err); }
      });
    }else{

    }
  }

  api.tasks.placeInQueue = function(api, taskId, queue, callback){
    api.tasks.setTaskData(api, taskId, {queue: queue}, function(err){
      if(api.redis.enable === true){
        api.redis.client.rpush(queue, taskId, function(err){
          if(typeof callback == "function"){ callback(err); }
        });
      }else{

      }
    });
  }

  api.tasks.queueLength = function(api, queue, callback){
    if(api.redis.enable === true){
      api.redis.client.llen(queue, function(err, length){
        if(typeof callback == "function"){ callback(err, length); }
      });
    }else{

    }
  }

  api.tasks.removeFromQueue = function(api, taskId, queue, callback){
    if(api.redis.enable === true){
      api.redis.client.lrem(queue, 1, taskId, function(err, count){
        api.tasks.clearTaskData(api, taskId, function(err){
          if(typeof callback == "function"){ callback(err, count); }
        });
      });
    }else{

    }
  }

  api.tasks.changeQueue = function(api, startQueue, endQueue, callback){
    if(api.redis.enable === true){
      // TODO: never have an instant where there is not a taskID within a queue
      api.redis.client.lpop(startQueue, function(err, taskIdReturned){
        if(taskIdReturned == null){
          callback(err, null);
        }else{
          api.tasks.setTaskData(api, taskIdReturned, {queue: endQueue}, function(err){
            api.redis.client.rpush(endQueue, taskIdReturned, function(err){
              api.tasks.getTaskData(api, taskIdReturned, function(err, data){
                var task = new api.task(data)
                callback(err, task);
              });
            });
          });
        }
      });
    }else{

    }
  }

  api.tasks.promoteFromDelayedQueue = function(api, callback){
    if(api.redis.enable === true){
      // TODO: never have an instant where there is not a taskID within a queue
      api.redis.client.lpop(api.tasks.queues.delayedQueue, function(err, taskIdReturned){
        if(taskIdReturned == null){
          callback(err, null);
        }else{
          api.tasks.getTaskData(api, taskIdReturned, function(err, data){
            if(data.runAt > new Date().getTime()){
              api.tasks.setTaskData(api, taskIdReturned, {queue: api.tasks.queues.globalQueue}, function(err){
                api.redis.client.rpush(api.tasks.queues.globalQueue, taskIdReturned, function(err){
                  var task = new api.task(data)
                  callback(err, task);
                });
              });
            }else{
              api.redis.client.rpush(api.tasks.queues.delayedQueue, taskIdReturned, function(err){
                callback(err, null);
              });
            }
          });
        }
      });
    }else{

    }
  }

  api.tasks.load = function(api){
    var validateTask = function(api, task){
      var fail = function(msg){
        api.log(msg + "; exiting.", ['red', 'bold']);
        process.exit();
      }
      if(typeof task.name != "string" && task.name.length < 1){
        fail("a task is missing `task.name`");
      }else if(typeof task.description != "string" && task.name.description < 1){
        fail("Task "+task.name+" is missing `task.description`");
      }else if(typeof task.scope != "string"){
        fail("Task "+task.name+" has no scope");
      }else if(typeof task.frequency != "number"){
        fail("Task "+task.name+" has no frequency");  
      }else if(typeof task.run != "function"){
        fail("Task "+task.name+" has no run method");
      }
    }
    
    var loadFolder = function(path){
      if(api.fs.existsSync(path)){
        api.fs.readdirSync(path).forEach( function(file) {
          if(path[path.length - 1] != "/"){ path += "/"; } 
          var fullfFilePath = path + file;
          if (file[0] != "."){
            var stats = api.fs.statSync(fullfFilePath);
            if(stats.isDirectory()){
              loadFolder(fullfFilePath);
            }else if(stats.isSymbolicLink()){
              var realPath = readlinkSync(fullfFilePath);
              loadFolder(realPath);
            }else if(stats.isFile()){
              taskLoader(api, fullfFilePath)
            }else{
              api.log(file+" is a type of file I cannot read", "red")
            }
          }
        });
      }else{
        api.log("No tasks folder found, skipping...");
      }
    }

    var taskLoader = function(api, fullfFilePath, reload){
      if(reload == null){ reload = false; }

      var loadMessage = function(loadedTaskName){
        if(reload){
          loadMessage = "task (re)loaded: " + loadedTaskName + ", " + fullfFilePath;
        }else{
          var loadMessage = "task loaded: " + loadedTaskName + ", " + fullfFilePath;
        }
        api.log(loadMessage, "yellow");
      }

      var parts = fullfFilePath.split("/");
      var file = parts[(parts.length - 1)];
      var taskName = file.split(".")[0];
      if(!reload){
        if(api.configData.general.developmentMode == true){
          api.watchedFiles.push(fullfFilePath);
          (function() {
            api.fs.watchFile(fullfFilePath, {interval:1000}, function(curr, prev){
              if(curr.mtime > prev.mtime){
                process.nextTick(function(){
                  if(api.fs.readFileSync(fullfFilePath).length > 0){
                    delete require.cache[fullfFilePath];
                    delete api.tasks.tasks[taskName];
                    taskLoader(api, fullfFilePath, true);
                  }
                });
              }
            });
          })();
        }
      }
      try{
        var collection = require(fullfFilePath);
        if(api.utils.hashLength(collection) == 1){
          api.tasks.tasks[taskName] = require(fullfFilePath).task;
          validateTask(api, api.tasks.tasks[taskName]);
          loadMessage(taskName);
        }else{
          for(var i in collection){
            var task = collection[i];
            api.tasks.tasks[task.name] = task;
            validateTask(api, api.tasks.tasks[task.name]);
            loadMessage(task.name);
          }
        }
      }catch(err){
        api.exceptionHandlers.loader(fullfFilePath, err);
        delete api.tasks.tasks[taskName];
      }
    }

    var taskFolders = [ 
      process.cwd() + "/tasks/", 
    ]

    for(var i in taskFolders){
      loadFolder(taskFolders[i]);
    }
  }

  api.tasks.load(api); // run right away
  next();

}

/////////////////////////////////////////////////////////////////////
// exports
exports.initTasks = initTasks;
