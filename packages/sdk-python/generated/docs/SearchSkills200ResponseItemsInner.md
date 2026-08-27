# SearchSkills200ResponseItemsInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**body_sha256** | **str** |  |
**created_at** | **str** |  |
**id** | **str** |  |
**kind** | **str** |  |
**lifecycle** | **str** |  |
**logical_key** | **str** |  |
**metadata** | **object** |  |
**name** | **str** |  |
**resources** | [**List[SearchSkills200ResponseItemsInnerResourcesInner]**](SearchSkills200ResponseItemsInnerResourcesInner.md) |  |
**scope** | [**SearchSkills200ResponseItemsInnerScope**](SearchSkills200ResponseItemsInnerScope.md) |  |
**summary** | **str** |  | [optional]
**total_size** | **int** |  |
**updated_at** | **str** |  |
**version** | **int** |  |

## Example

```python
from openapi_client.models.search_skills200_response_items_inner import SearchSkills200ResponseItemsInner

# TODO update the JSON string below
json = "{}"
# create an instance of SearchSkills200ResponseItemsInner from a JSON string
search_skills200_response_items_inner_instance = SearchSkills200ResponseItemsInner.from_json(json)
# print the JSON string representation of the object
print(SearchSkills200ResponseItemsInner.to_json())

# convert the object into a dict
search_skills200_response_items_inner_dict = search_skills200_response_items_inner_instance.to_dict()
# create an instance of SearchSkills200ResponseItemsInner from a dict
search_skills200_response_items_inner_from_dict = SearchSkills200ResponseItemsInner.from_dict(search_skills200_response_items_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
