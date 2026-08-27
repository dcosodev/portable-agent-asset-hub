# ResolveSkillGraphRequestLimits


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**max_depth** | **int** |  | [optional]
**max_resolved_skills** | **int** |  | [optional]

## Example

```python
from openapi_client.models.resolve_skill_graph_request_limits import ResolveSkillGraphRequestLimits

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveSkillGraphRequestLimits from a JSON string
resolve_skill_graph_request_limits_instance = ResolveSkillGraphRequestLimits.from_json(json)
# print the JSON string representation of the object
print(ResolveSkillGraphRequestLimits.to_json())

# convert the object into a dict
resolve_skill_graph_request_limits_dict = resolve_skill_graph_request_limits_instance.to_dict()
# create an instance of ResolveSkillGraphRequestLimits from a dict
resolve_skill_graph_request_limits_from_dict = ResolveSkillGraphRequestLimits.from_dict(resolve_skill_graph_request_limits_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
